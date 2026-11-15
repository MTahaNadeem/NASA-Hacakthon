import subprocess, glob, numpy as np, wave, os, json
SR=48000; DIR='/tmp/claude-0/res/vo_in/Voice over/'
# (file prefix, scheduled start in the 30 s timeline)
plan=[('Farmers repeat',0.12),('Rotation Explore',7.05),('Pick any',9.55),('and NASA',12.05),('you get rank',15.05),('Change your',18.05),('Everyscore',21.05),('even ehat',23.68),('A crop map',26.05)]
def load(path):
    raw=subprocess.run(['ffmpeg','-v','error','-i',path,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout
    return np.frombuffer(raw,dtype=np.float32).copy()
def db(x): return 20*np.log10(np.sqrt(np.mean(x**2))+1e-9)
def regions(x):
    h=int(SR*0.01); n=len(x)//h; e=np.array([db(x[i*h:(i+1)*h]) for i in range(n)])
    noise=np.percentile(e,10); thr=max(noise+12,-46); act=e>thr
    segs=[];s=None
    for i,a in enumerate(act):
        if a and s is None: s=i
        if not a and s is not None: segs.append([s,i]); s=None
    if s is not None: segs.append([s,n])
    # merge gaps shorter than 0.30 s, then drop blips shorter than 0.15 s (clicks, breaths)
    m=[]
    for a,b in segs:
        if m and a-m[-1][1]<30: m[-1][1]=b
        else: m.append([a,b])
    m=[r for r in m if r[1]-r[0]>=15]
    return [(a*0.01,b*0.01) for a,b in m],noise,thr
def fade(x,ms=14):
    n=int(SR*ms/1000); y=x.copy(); r=np.linspace(0,1,n); y[:n]*=r; y[-n:]*=r[::-1]; return y
def tempo(x,f):
    if abs(f-1)<0.005: return x
    p=subprocess.run(['ffmpeg','-v','error','-f','f32le','-ar',str(SR),'-ac','1','-i','-','-af',f'atempo={f}','-f','f32le','-'],input=x.tobytes(),capture_output=True).stdout
    return np.frombuffer(p,dtype=np.float32).copy()
out=np.zeros(int(30*SR)); log=[]; prev_end=0
for prefix,start in plan:
    f=[g for g in glob.glob(DIR+'*.m4a') if os.path.basename(g).startswith(prefix)][0]
    x=load(f); segs,noise,thr=regions(x)
    a=int(max(0,segs[0][0]-0.06)*SR); b=int(min(len(x)/SR,segs[-1][1]+0.10)*SR); y=x[a:b]
    # tighten long internal pauses (>0.30 s) to 0.22 s so the line flows
    pieces=[]; t=segs[0][0]-0.06
    for i,(s0,s1) in enumerate(segs):
        lo=int((s0-0.0)*SR) if i else a; hi=int(s1*SR) if i<len(segs)-1 else b
        pieces.append(x[lo:hi])
        if i<len(segs)-1:
            gap=segs[i+1][0]-s1; keep=min(gap,0.22) if gap>0.30 else gap
            pieces.append(np.zeros(int(keep*SR),dtype=np.float32))
    y=np.concatenate(pieces)
    y=y*10**((-20-db(y[np.abs(y)>np.percentile(np.abs(y),50)]))/20)   # equalise speech level between files
    dur0=len(y)/SR; win_end=29.7 if prefix=='A crop map' else (6.88 if prefix=='Farmers repeat' else None)
    s=max(start,prev_end+0.12 if prefix not in('Farmers repeat',) else start)
    nxt=[p for p in plan if p[1]>start]; limit=(nxt[0][1]-0.08) if nxt else 29.75
    if win_end: limit=win_end
    f_t=1.0
    if s+dur0>limit: f_t=min(1.14,dur0/(limit-s)); y=tempo(y,f_t)
    y=fade(y); i=int(s*SR); out[i:i+len(y)]+=y[:len(out)-i]; prev_end=s+len(y)/SR
    log.append(dict(file=os.path.basename(f)[:34],speech=[(round(a,2),round(b,2)) for a,b in segs],noise=round(noise,1),raw_dur=round(dur0,2),tempo=round(f_t,3),start=round(s,2),end=round(prev_end,2)))
for r in log: print(r)
pk=np.abs(out).max(); print('peak before master',round(20*np.log10(pk),1),'dBFS')
wav=out.astype(np.float32)
subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(SR),'-ac','1','-i','-','-af','highpass=f=75,acompressor=threshold=-24dB:ratio=2.2:attack=8:release=140:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=7,alimiter=limit=0.89','-ar','48000','-ac','1','human_vo_master.wav'],input=wav.tobytes(),check=True)
print('ok',subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0','human_vo_master.wav']).decode().strip())
json.dump(log,open('human_vo_log.json','w'),indent=1)
