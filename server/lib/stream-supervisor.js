import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isValidStreamName } from './streams.js';

const redactUrl = (value) => {
  try { const u = new URL(value); if (u.username) u.username = 'REDACTED'; if (u.password) u.password = 'REDACTED'; return u.toString(); }
  catch { return '[invalid source URL]'; }
};

export class StreamSupervisor {
  constructor({ hlsDir, archiveDir, logDir, sourceTemplate, staleMs = 30000, stopGraceMs = 5000, retryMs = 3000, spawnProcess = spawn, onSession = () => {} }) {
    this.hlsDir = hlsDir; this.archiveDir = archiveDir; this.logDir = logDir;
    this.sourceTemplate = sourceTemplate; this.staleMs = staleMs; this.stopGraceMs = stopGraceMs;
    this.retryMs = retryMs; this.spawnProcess = spawnProcess; this.onSession = onSession;
    this.entries = new Map(); this.closing = false;
  }
  state(name) {
    const e = this.entries.get(name);
    if (!e) return { name, desiredState: 'stopped', state: 'stopped', sourceConfigured: Boolean(this.sourceTemplate), pid: null, startedAt: null, lastTransitionAt: null, restartCount: 0, lastError: null, live: false };
    const manifest = path.join(this.hlsDir, name, 'stream.m3u8');
    let live = false; try { live = Date.now() - fs.statSync(manifest).mtimeMs < this.staleMs; } catch {}
    return { name, desiredState: e.desiredState, state: e.state, sourceConfigured: Boolean(this.sourceTemplate), pid: e.child?.pid ?? null, startedAt: e.startedAt, lastTransitionAt: e.lastTransitionAt, restartCount: e.restartCount, lastError: e.lastError, live };
  }
  list() { return [...new Set([...this.entries.keys()])].sort().map((name) => this.state(name)); }
  async start(name) {
    if (!isValidStreamName(name)) throw Object.assign(new Error('invalid stream name'), { statusCode: 400 });
    if (!this.sourceTemplate) throw Object.assign(new Error('RADIO_SOURCE_URL_TEMPLATE is not configured'), { statusCode: 503 });
    if (this.closing) throw Object.assign(new Error('relay is shutting down'), { statusCode: 503 });
    let e = this.entries.get(name);
    if (e && ['starting','running','stopping'].includes(e.state)) return this.state(name);
    if (!e) { e = { name, desiredState:'stopped', state:'stopped', child:null, startedAt:null, lastTransitionAt:new Date().toISOString(), restartCount:0, lastError:null, retryTimer:null, generation:0, stopping:null }; this.entries.set(name,e); }
    e.desiredState = 'running'; e.lastError = null; e.generation++;
    await this.#launch(e, e.generation);
    return this.state(name);
  }
  async #launch(e, generation) {
    e.state = 'starting'; e.lastTransitionAt = new Date().toISOString();
    fs.mkdirSync(path.join(this.hlsDir,e.name), { recursive:true }); fs.mkdirSync(this.archiveDir,{recursive:true}); fs.mkdirSync(this.logDir,{recursive:true});
    const source = this.sourceTemplate.replaceAll('{name}', e.name);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const archive = path.join(this.archiveDir, `${stamp}_${e.name}.mp3`);
    const log = fs.createWriteStream(path.join(this.logDir,`ffmpeg_${stamp}_${e.name}.log`), { flags:'a' });
    // Input URL comes only from deployment configuration, never from request bodies.
    const child = this.spawnProcess('ffmpeg', ['-nostdin','-hide_banner','-loglevel','warning','-i',source,'-vn','-c:a','aac','-b:a',process.env.AUDIO_BITRATE || '128k','-f','hls','-hls_time',process.env.HLS_TIME || '4','-hls_list_size',String(Math.max(10,Math.ceil(Number(process.env.DELAY_MAX_SECONDS || 60)/4)+6)),'-hls_flags','delete_segments+append_list+program_date_time','-hls_segment_filename',path.join(this.hlsDir,e.name,'seg%05d.ts'),path.join(this.hlsDir,e.name,'stream.m3u8'),'-vn','-c:a','libmp3lame','-b:a',process.env.AUDIO_BITRATE || '128k','-id3v2_version','3','-metadata',`title=${e.name}`,'-metadata',`date=${stamp}`,archive], { stdio:['ignore','ignore','pipe'] });
    e.child = child; e.startedAt = new Date().toISOString(); e.lastTransitionAt = e.startedAt; e.state = 'starting';
    child.stderr?.pipe(log);
    child.once('spawn', () => { if(e.generation === generation && e.desiredState === 'running') { e.state='running'; e.lastTransitionAt=new Date().toISOString(); this.onSession(e.name,'start',e.startedAt); } });
    child.once('error', (err) => { log.end(); if(e.generation !== generation) return; e.lastError = 'FFmpeg failed to start'; e.state='failed'; e.lastTransitionAt=new Date().toISOString(); e.child=null; this.#retry(e,generation); });
    child.once('close', (code, signal) => {
      log.end(); if(e.generation !== generation) return;
      e.child=null;
      if(e.desiredState === 'stopped' || this.closing) { e.state='stopped'; e.lastTransitionAt=new Date().toISOString(); this.onSession(e.name,'end',e.lastTransitionAt); return; }
      e.state='failed'; e.lastError=`FFmpeg exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}); source ${redactUrl(source)}`; e.lastTransitionAt=new Date().toISOString(); e.restartCount++; this.#retry(e,generation);
    });
  }
  #retry(e,generation) {
    if (e.desiredState !== 'running' || this.closing || e.retryTimer) return;
    const delay = Math.min(30000, this.retryMs * (2 ** Math.min(e.restartCount,4)));
    e.retryTimer=setTimeout(() => { e.retryTimer=null; if(e.generation===generation && e.desiredState==='running' && !this.closing) void this.#launch(e,generation); },delay);
    e.retryTimer.unref?.();
  }
  async stop(name) {
    if (!isValidStreamName(name)) throw Object.assign(new Error('invalid stream name'), { statusCode:400 });
    const e=this.entries.get(name);
    if (!e || !e.child) { if(e){e.desiredState='stopped';e.state='stopped';if(e.retryTimer)clearTimeout(e.retryTimer);e.retryTimer=null;} return this.state(name); }
    if(e.stopping) return e.stopping;
    e.desiredState='stopped'; e.state='stopping'; e.lastTransitionAt=new Date().toISOString(); e.generation++;
    if(e.retryTimer) clearTimeout(e.retryTimer); e.retryTimer=null;
    const child=e.child;
    e.stopping=(async()=>{ child.kill('SIGTERM'); await new Promise((resolve)=>{ let done=false; const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();}; child.once('close',finish); const timer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL'); finish();},this.stopGraceMs); timer.unref?.(); }); e.child=null;e.state='stopped';e.lastTransitionAt=new Date().toISOString();e.stopping=null; return this.state(name); })();
    return e.stopping;
  }
  async close() { this.closing=true; await Promise.all([...this.entries.keys()].map((n)=>this.stop(n))); }
}
