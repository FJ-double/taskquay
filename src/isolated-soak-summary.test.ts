import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSoakSegments, type SoakSegment } from "./isolated-soak-summary.js";
const base=(index:number):SoakSegment=>({
  schema:"taskquay-isolated-soak",version:2,status:"passed",
  started:`2026-10-15T02:0${index}:00.000Z`,
  finished:`2026-10-15T02:0${index}:50.000Z`,
  elapsedSeconds:50,requestedSeconds:45,testsOnly:true,nativeWindows:true,
  sourceFilesSha256:"a".repeat(64),fairnessRounds:100,syntheticAgentAdmissions:600,
  fifoNoBargeChecks:500,maxSimultaneousClaims:4,walBusyDenials:25,
  clientDisconnectRecoveries:8,serviceJobStops:2,residualClaims:0,
  residualWaiters:0,finalIntegrity:"ok",modelRequests:0,remoteProviderRequests:0,
  checkpointFailures:0,fifoWaitMilliseconds:{samples:600,p95:8,max:19},
  resourceSamples:[
    {elapsedSeconds:3,rssBytes:100,heapUsedBytes:50,walBytes:200,checkpointBusy:0},
    {elapsedSeconds:24,rssBytes:115,heapUsedBytes:55,walBytes:205,checkpointBusy:0},
    {elapsedSeconds:45,rssBytes:110,heapUsedBytes:53,walBytes:190,checkpointBusy:0},
  ],
});
test("separate completed synthetic soak receipts summarize totals and per-segment resource drift, not continuous uptime",()=>{
  const summary=summarizeSoakSegments([base(1),base(2)]);
  assert.equal(summary.segmentCount,2);
  assert.equal(summary.totalRequestedSeconds,90);
  assert.equal(summary.syntheticAgentAdmissions,1200);
  assert.equal(summary.segments[0].rssDeltaBytes,10);
  assert.equal(summary.segments[0].walDeltaBytes,-10);
  assert.match(summary.interpretation,/NOT uninterrupted/);
});
test("cumulative soak blocks failed, mismatched, duplicate, overlapping or insecure reports",()=>{
  const a=base(1),b=base(2);
  assert.throws(()=>summarizeSoakSegments([a,{...b,status:"failed"}]),/UNVERIFIED/);
  assert.throws(()=>summarizeSoakSegments([a,{...b,sourceFilesSha256:"b".repeat(64)}]),/UNVERIFIED/);
  assert.throws(()=>summarizeSoakSegments([a,a]),/DUPLICATE/);
  assert.throws(()=>summarizeSoakSegments([a,{...b,started:"2026-10-15T02:01:30.000Z"}]),/OVERLAPPING/);
  assert.throws(()=>summarizeSoakSegments([a,{...b,resourceSamples:[...b.resourceSamples.slice(0,2),{...b.resourceSamples[2],checkpointBusy:1}]}]),/UNVERIFIED/);
  assert.throws(()=>summarizeSoakSegments([a,{...b,residualClaims:1}]),/UNVERIFIED/);
});
