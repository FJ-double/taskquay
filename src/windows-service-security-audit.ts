export interface PipeAclReview {
  mode:"read_only";
  verifiedExclusive:boolean;
  findings:string[];
}

/**
 * Deliberately conservative SDDL screening. Not a Windows effective
 * access-check replacement: deny/conditional/group/impersonation rules
 * need real restricted-account validation before production.
 */
export function screenWindowsPipeSddl(sddl:string):PipeAclReview {
  const findings:string[]=[];
  if (!sddl.startsWith("D:") || sddl.length>16_384) {
    return {mode:"read_only",verifiedExclusive:false,
      findings:["PIPE_DACL_MISSING_OR_INVALID"]};
  }
  const entries=[...sddl.matchAll(/\(([^()]*)\)/g)].map((match)=>match[1].split(";"));
  if (entries.length===0) findings.push("PIPE_DACL_EMPTY_OR_UNREADABLE");
  const broad=new Set(["WD","AN","AU","BU","IU","NU","S-1-1-0","S-1-5-7",
    "S-1-5-11","S-1-5-32-545"]);
  for(const fields of entries){
    const [type,,rights,,,trustee]=fields;
    if(type?.startsWith("A")&&broad.has(trustee??"")){
      if (/^(?:0x[0-9a-f]+|[A-Z]+)$/i.test(rights??"")) {
        findings.push("PIPE_BROAD_ALLOW_ACE_"+trustee);
      } else findings.push("PIPE_UNPARSABLE_BROAD_ALLOW");
    }
  }
  if(!entries.some((fields)=>fields[0]?.startsWith("A") &&
    (fields[5]==="SY"||fields[5]==="BA"||fields[5]?.startsWith("S-1-5-21-")))){
    findings.push("PIPE_PRIVILEGED_OWNER_ALLOW_UNVERIFIED");
  }
  // An SDDL lexical screen cannot establish effective cross-user
  // isolation: always mark incomplete until native Authz + impersonated
  // process tests are implemented. Never allow it to enable production.
  findings.push("PIPE_EFFECTIVE_CROSS_ACCOUNT_ACCESS_NOT_VERIFIED");
  return {mode:"read_only",verifiedExclusive:false,findings:[...new Set(findings)]};
}
