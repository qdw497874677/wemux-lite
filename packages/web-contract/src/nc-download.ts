/** Standalone Node source embedded in enrollment commands and the installer.
 * No dependencies or shell single quotes. Downloads only our Content-Length HTTP
 * endpoints; never publishes a partial response. Keep stdin open: tailscale nc
 * can stop copying the response as soon as it sees local input EOF.
 */
export const ncDownloadScript = String.raw`
const{spawn}=require("node:child_process"),fs=require("node:fs/promises");
const[h,p,u,out]=process.argv.slice(1),sk=process.env.WEMUX_TS_SOCKET;
(async()=>{
if(!out)throw Error("download output path is required");
const host=h.replace(/^\[|\]$/g,"");
const nc=spawn("tailscale",sk?["--socket",sk,"nc",host,p]:["nc",host,p]);
let spawnError,timedOut=false,file,header=Buffer.alloc(0),length=null,received=0;
const closed=new Promise(resolve=>{nc.on("error",e=>{spawnError=e});nc.on("close",(code,signal)=>resolve({code,signal}))});
nc.stderr.pipe(process.stderr);
nc.stdin.on("error",()=>{});
const timer=setTimeout(()=>{timedOut=true;nc.kill("SIGKILL")},30000);
try{
nc.stdin.write("GET "+u+" HTTP/1.1\r\nHost: "+h+":"+p+"\r\nConnection: close\r\n\r\n");
for await(const chunk of nc.stdout){
let data=chunk;
if(length===null){
header=Buffer.concat([header,chunk]);const i=header.indexOf("\r\n\r\n");
if(i<0){if(header.length>65536)throw Error("HTTP response headers too large");continue}
if(i>65536)throw Error("HTTP response headers too large");
const text=header.subarray(0,i).toString();
if(!/^HTTP\/1\.[01] 200(?: |$)/.test(text))throw Error("HTTP download failed: "+text.split("\r\n")[0]);
const sizes=[...text.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
if(sizes.length!==1||/^transfer-encoding:/im.test(text))throw Error("HTTP response requires Content-Length without Transfer-Encoding");
length=Number(sizes[0][1]);if(!Number.isSafeInteger(length)||length<=0)throw Error("Empty or invalid HTTP response length");
file=await fs.open(out+".part","w",0o600);data=header.subarray(i+4);header=null;
}
received+=data.length;if(received>length)throw Error("HTTP response exceeds Content-Length");
await file.writeFile(data);
}
const result=await closed;
if(spawnError)throw spawnError;
if(timedOut)throw Error("tailscale nc download timed out after 30 seconds");
if(result.code!==0||result.signal)throw Error("tailscale nc failed: "+(result.signal||result.code));
if(length===null||received!==length)throw Error("Incomplete HTTP response: "+received+" / "+length);
await file.close();file=null;await fs.rename(out+".part",out);
}finally{
clearTimeout(timer);nc.stdin.destroy();nc.kill("SIGKILL");await closed;
if(file)await file.close();await fs.rm(out+".part",{force:true});
}
})().catch(e=>{console.error("nc download: "+e.message);process.exitCode=1});
`.trim().split('\n').join('')
