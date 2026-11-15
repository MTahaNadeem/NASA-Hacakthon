import subprocess, glob, json, os
from PIL import Image, ImageDraw, ImageFont
A=glob.glob('vid2/*.webm')[0]; B=glob.glob('vid3/*.webm')[0]
F=lambda w,b=True: ImageFont.truetype('/usr/share/fonts/opentype/inter/Inter-%s.otf'%('Bold' if b else 'Medium'), w)
os.makedirs('ov',exist_ok=True)
def pill(name,text):
    f=F(26); d=ImageDraw.Draw(Image.new('RGBA',(10,10))); w=int(d.textlength(text,font=f))+48
    im=Image.new('RGBA',(w,52),(0,0,0,0)); dr=ImageDraw.Draw(im); dr.rounded_rectangle((0,0,w-1,51),radius=26,fill=(15,50,30,235)); dr.text((24,10),text,font=f,fill=(255,255,255,255)); im.save(f'ov/{name}.png'); return w
labels={'l1':'1  Pick any place','l2':'2  NASA data loads (sped up)','l3':'3  Ranked rotations in plain words','l4':'4  Change your priorities','l5':'5  Every score shows its evidence','l6':'6  What if the weather changes?','l7':'7  Real crop areas, never invented'}
for k,v in labels.items(): pill(k,v)
# problem card
card=Image.new('RGBA',(820,300),(0,0,0,0)); d=ImageDraw.Draw(card); d.rounded_rectangle((0,0,819,299),radius=28,fill=(12,34,21,250))
d.text((44,34),'THE PROBLEM',font=F(24),fill=(255,180,90,255)); d.text((44,82),'Same crop, same land,',font=F(54),fill=(255,255,255,255)); d.text((44,146),'every single year.',font=F(54),fill=(255,255,255,255))
d.text((44,230),'Tired soil  ·  scarce water  ·  rotation is guesswork',font=F(30,False),fill=(214,236,220,255)); card.save('ov/problem.png')
end=Image.new('RGBA',(1280,185),(0,0,0,0)); d=ImageDraw.Draw(end); d.rectangle((0,0,1280,185),fill=(15,40,25,238)); d.text((60,26),'Rotation Explorer',font=F(52),fill=(255,255,255,255)); d.text((60,92),'mtahanadeem.github.io/NASA-Hacakthon   ·   free, 10 languages',font=F(30,False),fill=(190,230,200,255)); d.text((60,142),'Screen recording and code made with AI help (Claude)   ·   Satellite imagery: NASA GIBS',font=F(21,False),fill=(160,205,175,255)); end.save('ov/end.png')
# segments: (label, input, src_start, src_dur, out_dur, overlay)
segs=[('problem','still',41.2,None,7.0,'problem'),
      ('start',A,42.9,2.5,2.5,None),
      ('pick',A,45.4,2.5,2.5,'l1'),
      ('load',B,3.2,19.4,3.0,'l2'),
      ('result',A,52.5,3.0,3.0,'l3'),
      ('prio',A,55.6,7.0,3.0,'l4'),
      ('evid',A,64.5,4.5,2.5,'l5'),
      ('whatif',A,70.5,5.0,2.5,'l6'),
      ('crops',A,97.5,6.5,3.0,'l7'),
      ('end',A,109.6,1.0,1.0,'end')]
subprocess.run(['ffmpeg','-v','error','-y','-ss','41.2','-i',A,'-frames:v','1','still.png'],check=True)
inputs=[]; parts=[]; ov_in=[]; idx=0; t=0.0; times=[]
for i,(n,src,ss,sd,od,ov) in enumerate(segs):
    if src=='still': inputs+=['-loop','1','-framerate','30','-t',str(od),'-i','still.png']
    else: inputs+=['-ss',str(ss),'-t',str(sd),'-i',src]
    inputs_idx=i
    if src=='still': parts.append(f'[{i}:v]scale=1280:720,fps=30,setsar=1,eq=brightness=-0.45:saturation=0.7,trim=duration={od},setpts=PTS-STARTPTS[s{i}]')
    else: parts.append(f'[{i}:v]scale=1280:720,fps=30,setsar=1,setpts=(PTS-STARTPTS)*{od/sd:.5f},trim=duration={od},setpts=PTS-STARTPTS[s{i}]')
    times.append((n,round(t,2),round(t+od,2),ov)); t+=od
n=len(segs); concat=''.join(f'[s{i}]' for i in range(n))+f'concat=n={n}:v=1:a=0[base]'
extra=[]; chain='[base]'; k=n
for (name,a,b,ov) in times:
    if not ov: continue
    p=f'ov/{ov}.png'; inputs+=['-i',p]
    if ov=='problem': pos='(W-w)/2:(H-h)/2'
    elif ov=='end': pos='0:H-h'
    else: pos='(W-w)/2+120:20'
    extra.append(f'{chain}[{k}:v]overlay={pos}:enable=\'between(t,{a+0.05},{b-0.05})\'[o{k}]'); chain=f'[o{k}]'; k+=1
fc=';'.join(parts+[concat]+extra)+f';{chain}tpad=stop_mode=clone:stop_duration=1[outv]'
subprocess.run(['ffmpeg','-v','error','-y',*inputs,'-filter_complex',fc,'-map','[outv]','-frames:v','900','-r','30','-c:v','libx264','-preset','slow','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart','-an','final30_silent_human.mp4'],check=True)
json.dump(times,open('timeline.json','w'),indent=1); print(times)
