import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createTestOnlyVersion17Fixture, migrateDatabase } from "./migrations.js";

const sum=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
type Stats = {version:number; workspaces:number; claims:number; waiters:number; integrity:string; foreignKeyErrors:number};
function report(db:Database.Database):Stats {
  const count=(name:string)=>Number((db.prepare(`select count(*) as n from ${name}`).get() as {n:number}).n);
  return {
    version:Number((db.prepare("select max(version) as n from devspace_schema_migrations").get() as {n:number}).n),
    workspaces:count("workspace_sessions"),
    claims:count("execution_claims"),
    waiters:count("execution_waiters"),
    integrity:(db.pragma("integrity_check",{simple:true}) as string),
    foreignKeyErrors:(db.pragma("foreign_key_check") as unknown[]).length,
  };
}
function sourceFixture() {
  const dir=mkdtempSync(join(tmpdir(),"taskquay-sqlite-shadow-"));
  const source=join(dir,`v17-source-${randomUUID()}.sqlite`);
  const sourceDb=new Database(source);
  try {
    sourceDb.pragma("foreign_keys = ON");
    sourceDb.pragma("journal_mode = DELETE");
    const previous=process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL;
    process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL="1";
    try {createTestOnlyVersion17Fixture(sourceDb);}
    finally {
      if(previous===undefined)delete process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL;
      else process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL=previous;
    }
    sourceDb.prepare(
      "insert into workspace_sessions(id,root,created_at,last_used_at) values(?,?,?,?)",
    ).run("shadow-fixture",dir,"2026-10-14","2026-10-14");
    sourceDb.prepare(
      "insert into execution_claims(id,owner_id,owner_pid,kind,checkout_root,agent_id,resources,acquired_at) values(?,?,?,?,?,?,?,?)",
    ).run("legacy-claim","test-owner",999,"command",dir,null,"[]","2026-10-14");
    sourceDb.prepare(
      "insert into execution_waiters(id,owner_id,owner_pid,kind,checkout_root,agent_id,thread_key,access_mode,resources,expires_at_ms) values(?,?,?,?,?,?,?,?,?,?)",
    ).run("legacy-waiter","test-owner",999,"agent",dir,null,null,"write","[]",1234567890123);
    assert.deepEqual(report(sourceDb),{
      version:17, workspaces:1, claims:1, waiters:1, integrity:"ok",foreignKeyErrors:0,
    });
  } catch(error) { sourceDb.close(); rmSync(dir,{recursive:true,force:true}); throw error; }
  sourceDb.close();
  return {dir,source,close:()=>rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
}
async function nativeBackup(source:string,destination:string) {
  const reader=new Database(source,{readonly:true,fileMustExist:true});
  try {
    const before=report(reader);
    const backupResult=await reader.backup(destination);
    assert.ok(backupResult,"SQLite Online Backup API must return completion metadata");
    return before;
  } finally {reader.close();}
}

test("disposable v17 SQLite source is backed up read-only, migrated ONLY in a shadow copy through v21, and restored reversibly",async()=>{
  const f=sourceFixture();
  try {
    const originalSha=sum(f.source), backup=join(f.dir,"v17-native-backup.sqlite");
    const initial=await nativeBackup(f.source,backup);
    const backupSha=sum(backup);
    assert.equal(sum(f.source),originalSha,"read-only SQLite backup must not modify source DB bytes");
    const shadow=join(f.dir,"isolated-migrated-shadow.sqlite");
    copyFileSync(backup,shadow);
    const dest=new Database(shadow);
    try {
      dest.pragma("journal_mode = DELETE");
      dest.pragma("foreign_keys = ON");
      migrateDatabase(dest);
      const upgraded=report(dest);
      assert.deepEqual(upgraded,{
        ...initial,version:21,
      },"legacy claim, waiter and workspace counts survive migration");
      assert.equal((dest.prepare("select count(*) as n from devspace_schema_migrations").get() as {n:number}).n,21);
      const waiterColumns=dest.pragma("table_info(execution_waiters)") as Array<{name:string;notnull:number}>;
      assert.equal(waiterColumns.find((row)=>row.name==="expires_at_ms")?.notnull,0);
      assert(dest.prepare("select name from sqlite_master where name='managed_service_health_journal'").get());
      assert(dest.prepare("select name from sqlite_master where name='managed_service_reservations'").get());
      assert.equal(
        (dest.prepare("select execution_id from execution_claims where id='legacy-claim'").get() as {execution_id:string|null}).execution_id,
        null,"unknown legacy claim must not become automatically managed after upgrade");
      assert.equal((dest.prepare("select id from execution_waiters where id='legacy-waiter'").get() as {id:string}).id,"legacy-waiter");
    } finally {dest.close();}
    assert.equal(sum(f.source),originalSha,"migration must never write to the original SQLite DB");
    assert.equal(sum(backup),backupSha,"pre-migration backup is immutable");
    const restored=join(f.dir,"restored-from-backup.sqlite");
    copyFileSync(backup,restored);
    assert.equal(sum(restored),backupSha,"rollback can restore the exact backup bytes");
    const verified=new Database(restored,{readonly:true,fileMustExist:true});
    try { assert.deepEqual(report(verified),initial); }
    finally {verified.close();}
  } finally {f.close();}
});

test("injected incompatible shadow migration fails closed, leaves original/backup unchanged and can be rolled back",async()=>{
  const f=sourceFixture();
  try {
    const initialHash=sum(f.source), backup=join(f.dir,"pre-migration-backup.sqlite");
    const expected=await nativeBackup(f.source,backup);
    const backupHash=sum(backup), shadow=join(f.dir,"incompatible-shadow.sqlite");
    copyFileSync(backup,shadow);
    const failed=new Database(shadow);
    try {
      failed.pragma("journal_mode = DELETE");
      failed.prepare("update devspace_schema_migrations set name='incompatible' where version=17").run();
      assert.throws(()=>migrateDatabase(failed),/Database migration history is incompatible/);
      assert.equal(report(failed).version,17);
      assert.equal(
        (failed.prepare("select name from devspace_schema_migrations where version=17").get() as {name:string}).name,
        "incompatible",
      );
      assert.equal(failed.prepare("select name from sqlite_master where name='managed_service_reservations'").get(),undefined);
    } finally {failed.close();}
    assert.equal(sum(f.source),initialHash,"failed shadow migration cannot corrupt original source");
    assert.equal(sum(backup),backupHash);
    const restored=join(f.dir,"rollback-after-failure.sqlite");
    copyFileSync(backup,restored);
    assert.equal(sum(restored),backupHash);
    const verifier=new Database(restored,{readonly:true,fileMustExist:true});
    try { assert.deepEqual(report(verifier),expected); }
    finally {verifier.close();}
  } finally {f.close();}
});

test("v17 fixture builder refuses missing explicit gate, in-memory DB and any pre-existing schema",()=>{
  const memory=new Database(":memory:");
  const prior=process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL;
  try {
    delete process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL;
    assert.throws(()=>createTestOnlyVersion17Fixture(memory),
      /SQLITE_V17_FIXTURE_EXPLICIT_TEST_GATE_REQUIRED/);
    process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL="1";
    assert.throws(()=>createTestOnlyVersion17Fixture(memory),
      /SQLITE_V17_FIXTURE_TEMP_SOURCE_ONLY/);
    assert.equal((memory.prepare("select count(*) as n from sqlite_master where type='table'").get() as {n:number}).n,0);
  } finally {
    if(prior===undefined)delete process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL;
    else process.env.TASKQUAY_SQLITE_SHADOW_REHEARSAL=prior;
    memory.close();
  }
});
