/**
 * Strictly summarizes independent, finished, synthetic Windows soak runs.
 * Additive uptime is NOT continuous uptime and does not authorize release.
 */
export interface SoakSegment {
  schema:"taskquay-isolated-soak";
  version:2;
  status:"passed"|"failed";
  started:string;
  finished:string;
  elapsedSeconds:number;
  requestedSeconds:number;
  testsOnly:boolean;
  nativeWindows:boolean;
  sourceFilesSha256:string;
  fairnessRounds:number;
  syntheticAgentAdmissions:number;
  fifoNoBargeChecks:number;
  maxSimultaneousClaims:number;
  walBusyDenials:number;
  clientDisconnectRecoveries:number;
  serviceJobStops:number;
  residualClaims:number|null;
  residualWaiters:number|null;
  finalIntegrity:string;
  modelRequests:number;
  remoteProviderRequests:number;
  checkpointFailures:number;
  fifoWaitMilliseconds:{samples:number;p95:number|null;max:number|null};
  resourceSamples:Array<{
    elapsedSeconds:number;rssBytes:number;heapUsedBytes:number;walBytes:number;
    checkpointBusy:number|null;
  }>;
}
export function summarizeSoakSegments(segments:readonly SoakSegment[]) {
  if(segments.length<2||segments.length>24)throw new Error("SOAK_AGGREGATE_SEGMENT_COUNT_INVALID");
  const first=segments[0];
  const seen=new Set<string>();
  for(const entry of segments) {
    if(entry.schema!=="taskquay-isolated-soak"||entry.version!==2||
        entry.status!=="passed"||entry.testsOnly!==true||entry.nativeWindows!==true||
        typeof entry.sourceFilesSha256!=="string"||
        !/^[a-f0-9]{64}$/.test(entry.sourceFilesSha256)||
        entry.sourceFilesSha256!==first.sourceFilesSha256||
        entry.residualClaims!==0||entry.residualWaiters!==0||
        entry.finalIntegrity!=="ok"||entry.checkpointFailures!==0||
        entry.modelRequests!==0||entry.remoteProviderRequests!==0||
        !Number.isFinite(entry.elapsedSeconds)||entry.elapsedSeconds<30||
        !Number.isFinite(entry.requestedSeconds)||entry.requestedSeconds<30||
        entry.maxSimultaneousClaims!==4||entry.serviceJobStops!==2||
        !Array.isArray(entry.resourceSamples)||entry.resourceSamples.length<3||
        entry.resourceSamples.some(v=>
          !Number.isFinite(v.rssBytes)||v.rssBytes<=0||
          !Number.isFinite(v.walBytes)||v.walBytes<0||
          v.checkpointBusy!==0)||
        !Number.isFinite(entry.fifoWaitMilliseconds.p95)||
        !Number.isFinite(entry.fifoWaitMilliseconds.max)){
      throw new Error("SOAK_AGGREGATE_UNVERIFIED_SEGMENT");
    }
    const start=new Date(entry.started).getTime(),end=new Date(entry.finished).getTime();
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||
        seen.has(entry.started))throw new Error("SOAK_AGGREGATE_DUPLICATE_OR_INVALID_TIME");
    seen.add(entry.started);
  }
  const sorted=[...segments].sort((a,b)=>a.started.localeCompare(b.started));
  for(let i=1;i<sorted.length;i++){
    if(new Date(sorted[i].started).getTime()<new Date(sorted[i-1].finished).getTime())
      throw new Error("SOAK_AGGREGATE_OVERLAPPING_SEGMENTS");
  }
  const sum=(field:keyof Pick<SoakSegment,
    "elapsedSeconds"|"requestedSeconds"|"fairnessRounds"|"syntheticAgentAdmissions"|
    "fifoNoBargeChecks"|"walBusyDenials"|"clientDisconnectRecoveries"|"serviceJobStops">)=>
    +sorted.reduce((acc,item)=>acc+(item[field] as number),0).toFixed(2);
  const segmentSummaries=sorted.map((entry)=>{
    const resources=entry.resourceSamples;
    const first=resources[0],last=resources[resources.length-1];
    return {
      started:entry.started,finished:entry.finished,requestedSeconds:entry.requestedSeconds,
      elapsedSeconds:entry.elapsedSeconds,
      rssStartBytes:first.rssBytes,rssEndBytes:last.rssBytes,
      rssDeltaBytes:last.rssBytes-first.rssBytes,
      rssPeakBytes:Math.max(...resources.map(v=>v.rssBytes)),
      walStartBytes:first.walBytes,walEndBytes:last.walBytes,
      walDeltaBytes:last.walBytes-first.walBytes,
      walPeakBytes:Math.max(...resources.map(v=>v.walBytes)),
      resourceSamples:resources.length,
      fifoWaitP95Ms:entry.fifoWaitMilliseconds.p95,
      fifoWaitMaxMs:entry.fifoWaitMilliseconds.max,
      dropRecoveries:entry.clientDisconnectRecoveries,
    };
  });
  return {
    schema:"taskquay-cumulative-isolated-soak",
    version:1, status:"passed",testOnly:true,
    interpretation:"sum of separate disposable segments, NOT uninterrupted service uptime or real-Provider load",
    sourceFilesSha256:first.sourceFilesSha256,
    segmentCount:sorted.length,
    totalRequestedSeconds:sum("requestedSeconds"),
    totalElapsedSeconds:sum("elapsedSeconds"),
    fairnessRounds:sum("fairnessRounds"),
    syntheticAgentAdmissions:sum("syntheticAgentAdmissions"),
    fifoNoBargeChecks:sum("fifoNoBargeChecks"),
    walBusyDenials:sum("walBusyDenials"),
    clientDisconnectRecoveries:sum("clientDisconnectRecoveries"),
    serviceJobStops:sum("serviceJobStops"),
    maxConcurrentClaims:Math.max(...sorted.map(v=>v.maxSimultaneousClaims)),
    worstSegmentFifoWaitP95Ms:Math.max(...segmentSummaries.map(v=>v.fifoWaitP95Ms!)),
    worstSegmentFifoWaitMaxMs:Math.max(...segmentSummaries.map(v=>v.fifoWaitMaxMs!)),
    maxObservedRssBytes:Math.max(...segmentSummaries.map(v=>v.rssPeakBytes)),
    maxObservedWalBytes:Math.max(...segmentSummaries.map(v=>v.walPeakBytes)),
    verifiedZeroResidual:true,verifiedCheckpointBusyZero:true,verifiedFinalIntegrity:true,
    segments:segmentSummaries,
  } as const;
}
