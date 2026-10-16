/**
 * Aggregate 2–24 explicitly named completed soak receipts.
 * Only reads receipts under releases/soak-receipts in this checkout.
 * Does NOT run new tests, repair a lock, or include the old v1 reports.
 */
import {randomUUID} from "node:crypto";
import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,realpathSync,writeSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {summarizeSoakSegments,type SoakSegment} from "../src/isolated-soak-summary.js";

const directory=resolve(dirname(fileURLToPath(import.meta.url)),"../releases/soak-receipts");
mkdirSync(directory,{recursive:true});
const canonicalDir=realpathSync(directory);
const args=process.argv.slice(2);
if(args.length<2||args.length>24)throw new Error("SOAK_SUMMARY_REQUIRES_2_TO_24_RECEIPTS");
const files=args.map(arg=>{
  if(!/^[0-9TZ-]+-[0-9a-f-]{36}\.json$/i.test(arg)||
      arg.startsWith("cumulative-"))throw new Error("SOAK_SUMMARY_FILENAME_INVALID");
  const candidate=realpathSync(join(canonicalDir,arg));
  if(!candidate.toLowerCase().startsWith((canonicalDir+sep).toLowerCase()))
    throw new Error("SOAK_SUMMARY_OUTSIDE_RECEIPT_DIRECTORY");
  return candidate;
});
const segments=files.map(f=>JSON.parse(readFileSync(f,"utf8")) as SoakSegment);
const summary=summarizeSoakSegments(segments);
const output=join(canonicalDir,
  "cumulative-"+new Date().toISOString().replace(/[:.]/g,"-")+"-"+randomUUID()+".json");
const fd=openSync(output,"wx",0o600);
try{writeSync(fd,JSON.stringify({...summary,receiptFilenames:args},null,2)+"\n");fsyncSync(fd);}
finally{closeSync(fd);}
console.log(JSON.stringify(summary));
console.log("SOAK_CUMULATIVE_RECEIPT="+output);
