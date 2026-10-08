"""Stormo: local dictation with Whisper. The audio stays in memory and never leaves this PC.

The process stays alive between one dictation and the next (the model isn't reloaded on every click).
Protocol, one JSON line per message:
  stdin   {"cmd": "start"} | {"cmd": "stop"} | {"cmd": "quit"}
  stdout  {"type": "state", "state": "listening" | "transcribing"}
          {"type": "ready", "model": "...", "device": "cuda" | "cpu"}
          {"type": "text", "text": "..."}
          {"type": "done"}
          {"type": "error", "message": "..."}
With --record-now it starts recording right away, while the model is still loading: whoever clicks
and starts speaking doesn't lose the first words.
For tests: STORMO_VOICE_WAV=file.wav uses that file instead of the microphone.
"""

import json
import os
import pathlib
import queue
import re
import sys
import threading

# On Windows, with stdout/stdin connected to a pipe, Python would use the local code page (cp1252):
# "perché" would reach Node as "perch?". Everything in UTF-8.
for stream in (sys.stdout, sys.stdin):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


RATE = 16000
BLOCK = 1600            # 100 ms
MIN_SEGMENT = 1.4       # seconds of audio before a pause can close a sentence
PAUSE = 1.1             # seconds of silence that close a sentence
MAX_SEGMENT = 12.0      # a sentence never exceeds this limit
MIN_SPEECH_RMS = 0.012  # below this energy a block is silence (adapts to the microphone's noise)
MIN_AUDIO = 8000        # less than half a second: not transcribed
LANGUAGES = ("it", "en")

VOCABULARY = (
    "Stormo. Codex CLI, Claude Code, Antigravity, Gemini CLI, GLM, "
    "PowerShell, terminale, terminal, prompt, thread, agent, workspace, "
    "Python, JavaScript, TypeScript, Node.js, npm, Git, GitHub, API, "
    "file, cartella, folder, codice, code, comando, command, build, "
    "debug, deploy, pull request, commit, repository."
)

# On silence or noise, Whisper sometimes "invents" phrases from YouTube subtitles.
HALLUCINATIONS = re.compile(
    r"amara\.org|sottotitoli (e revisione|creati|a cura|di)|sottotitolato da|thanks for watching|"
    r"thank you for watching|subtitles by|please subscribe|iscriviti al canale|"
    r"grazie (a tutti )?per la visione|alla prossima puntata",
    re.IGNORECASE,
)


def normalize(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


VOCAB_NORMALIZED = normalize(VOCABULARY)


class Segmenter:
    """Cuts the audio stream into sentences using the audio's own time (not the clock's)."""

    def __init__(self, np):
        self.np = np
        self.noise = 0.004
        self.reset()

    def reset(self):
        self.samples = []
        self.count = 0
        self.voice_seen = False
        self.last_loud = 0.0

    def feed(self, block):
        np = self.np
        rms = float(np.sqrt(np.mean(block * block)))
        loud = rms > max(MIN_SPEECH_RMS, self.noise * 3.0)
        if not loud:
            self.noise = min(0.02, max(0.001, 0.98 * self.noise + 0.02 * rms))
        self.samples.append(block)
        self.count += len(block)
        t = self.count / RATE
        if loud:
            self.voice_seen = True
            self.last_loud = t
        if not self.voice_seen and t > 2.0:
            # silence only: keep the last half second so nothing grows forever
            tail = np.concatenate(self.samples)[-RATE // 2:]
            self.samples = [tail]
            self.count = len(tail)
            return None
        if self.voice_seen and ((t >= MIN_SEGMENT and t - self.last_loud > PAUSE) or t >= MAX_SEGMENT):
            return self.take()
        return None

    def take(self):
        if not self.samples or not self.voice_seen:
            self.reset()
            return None
        audio = self.np.concatenate(self.samples)
        self.reset()
        return audio


class MicSource:
    def __init__(self, sd, audio_q):
        self.sd = sd
        self.q = audio_q
        self.stream = None

    def start(self):
        def callback(indata, frames, timing, status):
            self.q.put(indata[:, 0].copy())

        self.stream = self.sd.InputStream(samplerate=RATE, channels=1, dtype="float32",
                                          blocksize=BLOCK, callback=callback)
        self.stream.start()

    def stop(self):
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            finally:
                self.stream = None


class WavSource:
    """For tests only: reads a WAV file as if it were the microphone (fast, in blocks)."""

    def __init__(self, np, path, audio_q):
        import wave
        with wave.open(path, "rb") as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(frames)
        if width != 2:
            raise RuntimeError("The test WAV must be 16-bit")
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            data = data.reshape(-1, channels).mean(axis=1)
        if rate != RATE:
            x = np.linspace(0, len(data), int(len(data) * RATE / rate), endpoint=False)
            data = np.interp(x, np.arange(len(data)), data).astype(np.float32)
        silence = np.zeros(int(RATE * 1.6), dtype=np.float32)
        self.data = np.concatenate([np.zeros(int(RATE * 0.3), dtype=np.float32), data, silence])
        self.q = audio_q
        self.np = np

    def start(self):
        def feed():
            for i in range(0, len(self.data), BLOCK):
                block = self.data[i:i + BLOCK]
                if len(block) < BLOCK:
                    block = self.np.pad(block, (0, BLOCK - len(block)))
                self.q.put(block)
            self.q.put(None)   # end of file

        threading.Thread(target=feed, daemon=True).start()

    def stop(self):
        pass


def main():
    record_now = "--record-now" in sys.argv
    wav_path = os.environ.get("STORMO_VOICE_WAV")

    try:
        import numpy as np
        audio_q = queue.Queue()
        if wav_path:
            source_factory = lambda: WavSource(np, wav_path, audio_q)
        else:
            import sounddevice as sd
            source_factory = lambda: MicSource(sd, audio_q)
    except Exception as exc:
        emit("error", message="Audio not available: " + str(exc))
        return 1

    cmds = queue.Queue()
    session = {"recording": False, "source": None, "stop": False}
    segmenter = Segmenter(np)

    def begin():
        segmenter.reset()
        while not audio_q.empty():
            audio_q.get_nowait()
        session["source"] = source_factory()
        session["source"].start()
        session["recording"] = True
        session["stop"] = False
        emit("state", state="listening")

    if record_now:
        try:
            begin()
        except Exception as exc:
            emit("error", message="Microphone not available: " + str(exc))
            return 1

    try:
        import torch
        import whisper
    except Exception as exc:
        emit("error", message="A Python package for dictation is missing: " + str(exc))
        return 1

    use_gpu = torch.cuda.is_available()
    cache = pathlib.Path.home() / ".cache" / "whisper"
    order = ["small", "base", "tiny"] if use_gpu else ["base", "tiny", "small"]
    names = [n for n in order if (cache / (n + ".pt")).is_file()]
    if not names:
        emit("error", message="Local speech model missing in " + str(cache))
        return 1
    model = None
    device = "cuda" if use_gpu else "cpu"
    for name in names:
        try:
            model = whisper.load_model(str(cache / (name + ".pt")), device=device)
            break
        except RuntimeError as exc:
            if device == "cuda" and "out of memory" in str(exc).lower():
                torch.cuda.empty_cache()
                device, use_gpu = "cpu", False
                names = [n for n in ["base", "tiny"] if (cache / (n + ".pt")).is_file()]
                try:
                    model = whisper.load_model(str(cache / (names[0] + ".pt")), device="cpu")
                    name = names[0]
                    break
                except Exception as exc2:
                    emit("error", message="Not enough GPU memory and the CPU model does not start: " + str(exc2))
                    return 1
            emit("error", message="Could not load the speech model: " + str(exc))
            return 1
    dtype = torch.float16 if use_gpu else torch.float32

    def detect_language(audio):
        """Picks between Italian and English: free detection on short sentences often gets the language wrong."""
        try:
            mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio), n_mels=model.dims.n_mels)
            mel = mel.to(model.device).to(dtype)
            _, probs = model.detect_language(mel)
            return max(LANGUAGES, key=lambda code: probs.get(code, 0.0))
        except Exception:
            return None

    def transcribe(audio):
        if audio is None or len(audio) < MIN_AUDIO:
            return
        if float(np.sqrt(np.mean(audio * audio))) < 0.004:
            return
        emit("state", state="transcribing")
        result = model.transcribe(
            audio, language=detect_language(audio), task="transcribe", fp16=use_gpu,
            condition_on_previous_text=False, temperature=0, no_speech_threshold=0.55,
            initial_prompt=VOCABULARY,
        )
        parts = []
        for seg in result.get("segments", []):
            if seg.get("no_speech_prob", 0.0) > 0.6 and seg.get("avg_logprob", 0.0) < -0.8:
                continue
            if seg.get("compression_ratio", 0.0) > 2.4:
                continue
            parts.append(str(seg.get("text", "")))
        text = " ".join(" ".join(parts).split())
        norm = normalize(text)
        if not text or HALLUCINATIONS.search(text) or (len(norm) > 12 and norm in VOCAB_NORMALIZED):
            return
        emit("text", text=text)

    def feed(block):
        segment = segmenter.feed(block)
        if segment is not None:
            transcribe(segment)
            if session["recording"] and not session["stop"]:
                emit("state", state="listening")

    def finish():
        src = session["source"]
        session["source"] = None
        if src is not None:
            try:
                src.stop()
            except Exception:
                pass
        while True:
            try:
                block = audio_q.get_nowait()
            except queue.Empty:
                break
            if block is not None:
                feed(block)
        transcribe(segmenter.take())
        session["recording"] = False
        session["stop"] = False
        emit("done")

    emit("ready", model=name, device=device)

    # On Windows, reading stdin in a thread while NumPy is being imported can block the import for ~25s:
    # the reader only starts now. Any commands that arrived earlier wait in the pipe.
    def reader():
        for line in sys.stdin:
            try:
                cmd = json.loads(line).get("cmd")
            except Exception:
                continue
            cmds.put(cmd)
        cmds.put("quit")   # the parent program has gone away

    threading.Thread(target=reader, daemon=True).start()

    while True:
        try:
            while True:
                cmd = cmds.get_nowait()
                if cmd == "quit":
                    if session["recording"]:
                        finish()
                    return 0
                if cmd == "start" and not session["recording"]:
                    try:
                        begin()
                    except Exception as exc:
                        emit("error", message="Microphone not available: " + str(exc))
                        return 1
                elif cmd == "stop" and session["recording"]:
                    session["stop"] = True
        except queue.Empty:
            pass
        if not session["recording"]:
            try:
                cmd = cmds.get(timeout=0.3)
            except queue.Empty:
                continue
            cmds.put(cmd)   # it will be read again next loop
            continue
        try:
            block = audio_q.get(timeout=0.05)
        except queue.Empty:
            block = False
        if block is None:          # end of the test file
            session["stop"] = True
        elif block is not False:
            feed(block)
        if session["stop"] and audio_q.empty():
            finish()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # any unexpected error reaches the UI as text, not as a broken window
        emit("error", message=str(exc))
        sys.exit(1)
