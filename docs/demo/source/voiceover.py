import json, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
k=Kokoro('kokoro.onnx','voices.bin'); VOICE='af_heart'
lines=[(0.15,6.85,"Farmers repeat the same crop every year. Soil tires, water runs short, and choosing a better rotation is guesswork."),
(7.0,2.5,"Rotation Explorer changes that."),
(9.5,2.5,"Pick any place on Earth,"),
(12.0,3.0,"and NASA data loads automatically."),
(15.0,3.0,"You get ranked crop rotations, in plain words."),
(18.0,3.0,"Change your priorities and it updates instantly."),
(21.0,2.5,"Every score shows its evidence,"),
(23.5,2.5,"even what if the weather changes."),
(26.0,2.7,"A crop map shows real fields, never invented."),
(28.85,1.1,"Free. Ten languages.")]
SR=24000; out=np.zeros(int(30.0*SR)); report=[]; prev_end=0
for start,win,text in lines:
    best=None
    for sp in [1.0,1.08,1.16,1.24,1.32]:
        a,sr=k.create(text,voice=VOICE,speed=sp,lang='en-us'); d=len(a)/sr; best=(a,d,sp)
        if d<=win-0.12: break
    a,d,sp=best; s=max(start+0.05,prev_end+0.04); 
    if s+d>29.98: s=max(0,29.98-d)
    i=int(s*SR); out[i:i+len(a)]+=a; prev_end=s+d; report.append((round(s,2),round(s+d,2),round(win,2),sp,text[:40]))
for r in report: print(r)
out=out/max(1e-6,np.abs(out).max())*0.89
sf.write('vo.wav',out,SR); print('total',len(out)/SR)
