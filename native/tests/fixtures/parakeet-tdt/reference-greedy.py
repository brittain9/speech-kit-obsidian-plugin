"""Optional CPU parity diagnostic for reviewed, pinned local export artifacts.

Requires existing NumPy/ONNX Runtime; downloads nothing and only reads fixtures.
Greedy recurrence follows onnx-asr a2fd753 (MIT; see THIRD_PARTY_NOTICES.md).
"""
import json, wave, pathlib, os
import numpy as np
import onnxruntime as ort
root=pathlib.Path(os.environ['STT_COMPARE_MODEL']).resolve().parent
fixtures=pathlib.Path(__file__).resolve().parents[1] / 'audio'
opts=ort.SessionOptions();opts.intra_op_num_threads=8
frontend=ort.InferenceSession(str(root/'nemo128.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
encoder=ort.InferenceSession(str(root/'encoder-model.int8.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
decoder=ort.InferenceSession(str(root/'decoder_joint-model.int8.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
vocab={int(i):p.replace('▁',' ') for p,i in (x.rsplit(' ',1) for x in (root/'vocab.txt').read_text().splitlines())}
for name in ['de-fleurs-1577.wav','de-fleurs-1618.wav','de-fleurs-1617.wav']:
 with wave.open(str(fixtures/name)) as w:
  samples=np.frombuffer(w.readframes(w.getnframes()),dtype=np.int16).astype(np.float32)/32768
 f,fl=frontend.run(['features','features_lens'],{'waveforms':samples[None,:],'waveforms_lens':np.array([len(samples)],dtype=np.int64)})
 e,el=encoder.run(['outputs','encoded_lengths'],{'audio_signal':f,'length':fl})
 e=e.transpose(0,2,1)[0]
 s1=np.zeros((2,1,640),dtype=np.float32);s2=s1.copy();tokens=[];times=[];t=0;emitted=0
 while t<int(el[0]):
  out,ns1,ns2=decoder.run(['outputs','output_states_1','output_states_2'],{'encoder_outputs':e[t][None,:,None],'targets':np.array([[tokens[-1] if tokens else 8192]],dtype=np.int32),'target_length':np.array([1],dtype=np.int32),'input_states_1':s1,'input_states_2':s2})
  out=out.squeeze();token=int(out[:8193].argmax());step=int(out[8193:].argmax())
  if token!=8192:
   s1,s2=ns1,ns2;tokens.append(token);times.append(t);emitted+=1
  if step>0:t+=step;emitted=0
  elif token==8192 or emitted==10:t+=1;emitted=0
 print(json.dumps({'file':name,'text':''.join(vocab[i] for i in tokens).strip(),'times':times}),flush=True)
