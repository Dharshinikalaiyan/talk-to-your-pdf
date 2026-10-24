// Ambient music and interface sounds, generated live with the Web Audio API (no audio files).
//
//   music  a warm, dreamy pad drifting through four chords in C-major pentatonic colours,
//          soft glass-bell notes now and then, and a gentle low pulse, all through a long
//          reverb. Each bell and pulse calls onBeat() so the 3D logo can beat along.
//   ui     hover shimmer, click pop, settings "bubble" pop, page-change whoosh.
//
// Browsers only allow audio after a click or key press, so nothing plays until then.
// While the microphone listens the music is silenced; while an answer is read aloud it ducks.

(function () {
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  // C, Am, F, G colours, voiced low and open (MIDI note numbers)
  const CHORDS = [
    [48, 55, 62, 64],   // C  G  D  E   (Cadd9)
    [45, 52, 55, 60],   // A  E  G  C   (Am7)
    [41, 48, 52, 57],   // F  C  E  A   (Fmaj7)
    [43, 50, 52, 57],   // G  D  E  A   (G6/9)
  ];
  const BELLS = [72, 74, 76, 79, 81, 84, 86, 88];   // C5 D5 E5 G5 A5 C6 D6 E6 (pentatonic)
  const CHORD_SECONDS = 8;
  const MUSIC_LEVEL = 0.32;

  class Ambient {
    constructor() {
      this.ctx = null;
      this.enabled = false;     // the user's choice (music + ui sounds)
      this.ducked = 0;          // 0 = full, 1 = ducked (speaking), 2 = silent (listening)
      this.onBeat = () => {};
      this._lastHover = 0;
    }

    _ensure() {
      if (this.ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);
      // music bus → gentle low-pass → master, plus a long reverb send
      this.music = ctx.createGain();
      this.music.gain.value = 0;
      this.tone = ctx.createBiquadFilter();
      this.tone.type = "lowpass";
      this.tone.frequency.value = 1800;
      this.music.connect(this.tone).connect(this.master);
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._impulse(4.5, 2.6);
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.85;
      this.reverb.connect(this.wet).connect(this.master);
      // interface sounds have their own bus (they stay audible when music is ducked)
      this.ui = ctx.createGain();
      this.ui.gain.value = 0.9;
      this.ui.connect(this.master);
      return true;
    }

    // A reverb "room": stereo noise that fades away exponentially.
    _impulse(seconds, decay) {
      const ctx = this.ctx, len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    /** Turn music + sounds on or off. Must first be called from a click/keypress. */
    async setEnabled(on) {
      this.enabled = on;
      if (on) {
        if (!this._ensure()) return;
        if (this.ctx.state === "suspended") await this.ctx.resume();
        this._fade(this.master.gain, 1, 1.2);
        this._fadeMusic();
        if (!this._running) this._startMusic();
      } else if (this.ctx) {
        this._fade(this.master.gain, 0, 0.8);
        clearTimeout(this._chordTimer); clearTimeout(this._bellTimer); clearTimeout(this._pulseTimer);
        this._running = false;
      }
    }

    /** 0 = normal, 1 = duck under speech, 2 = silent while the microphone listens. */
    duck(level) {
      this.ducked = level;
      this._fadeMusic();
    }

    _fadeMusic() {
      if (!this.ctx) return;
      const target = [MUSIC_LEVEL, MUSIC_LEVEL * 0.22, 0][this.ducked] * (this.enabled ? 1 : 0);
      this._fade(this.music.gain, target, this.ducked === 2 ? 0.25 : 1.2);
      this._fade(this.wet.gain, this.ducked === 2 ? 0 : 0.85, 0.3);
    }

    _fade(param, value, seconds) {
      const t = this.ctx.currentTime;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + seconds);
    }

    // ---------------------------------------------------------------- music

    _startMusic() {
      this._running = true;
      let chord = 0;
      const nextChord = () => {
        if (!this.enabled) { this._running = false; return; }
        this._playChord(CHORDS[chord % CHORDS.length]);
        chord++;
        this._chordTimer = setTimeout(nextChord, CHORD_SECONDS * 1000);
      };
      nextChord();
      const bell = () => {
        if (!this.enabled) return;
        if (this.ducked === 0 && Math.random() < 0.8) this._bell(BELLS[Math.floor(Math.random() * BELLS.length)]);
        this._bellTimer = setTimeout(bell, 900 + Math.random() * 2300);
      };
      this._bellTimer = setTimeout(bell, 1500);
      const pulse = () => {
        if (!this.enabled) return;
        if (this.ducked === 0) this._pulse();
        this._pulseTimer = setTimeout(pulse, 2000);
      };
      this._pulseTimer = setTimeout(pulse, 1000);
    }

    _playChord(notes) {
      const ctx = this.ctx, t = ctx.currentTime, len = CHORD_SECONDS + 4;
      for (const n of notes) {
        for (const [type, cents, level] of [["sine", -6, 0.09], ["triangle", 7, 0.035]]) {
          const osc = ctx.createOscillator(), g = ctx.createGain();
          osc.type = type;
          osc.frequency.value = midi(n);
          osc.detune.value = cents;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(level, t + 3);              // slow swell in
          g.gain.setValueAtTime(level, t + len - 4.5);
          g.gain.linearRampToValueAtTime(0, t + len);                // and out, overlapping the next chord
          osc.connect(g);
          g.connect(this.music);
          g.connect(this.reverb);
          osc.start(t);
          osc.stop(t + len + 0.1);
        }
      }
    }

    _bell(n) {
      const ctx = this.ctx, t = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      for (const [mult, lvl] of [[1, 1], [2.76, 0.25]]) {          // a glassy partial on top
        const osc = ctx.createOscillator(), og = ctx.createGain();
        osc.frequency.value = midi(n) * mult;
        og.gain.value = lvl;
        osc.connect(og).connect(g);
        osc.start(t);
        osc.stop(t + 3.3);
      }
      g.connect(this.music);
      g.connect(this.reverb);
      this.onBeat(0.35);
    }

    _pulse() {
      const ctx = this.ctx, t = ctx.currentTime;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.setValueAtTime(70, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.35);   // a soft, deep heartbeat
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.connect(g).connect(this.music);
      osc.start(t);
      osc.stop(t + 0.65);
      this.onBeat(0.5);
    }

    // ---------------------------------------------------------------- interface sounds

    _blip(from, to, seconds, level, type = "sine") {
      if (!this.enabled || !this.ctx || this.ctx.state !== "running") return;
      const ctx = this.ctx, t = ctx.currentTime;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.12);
      osc.connect(g);
      g.connect(this.ui);
      g.connect(this.reverb);
      osc.start(t);
      osc.stop(t + seconds + 0.15);
    }

    hover() {
      const now = performance.now();
      if (now - this._lastHover < 70) return;
      this._lastHover = now;
      this._blip(2200, 2900, 0.05, 0.018);
    }
    click() { this._blip(420, 980, 0.09, 0.07); }
    bubble() { this._blip(300, 1250, 0.16, 0.08); }

    whoosh(up = true) {
      if (!this.enabled || !this.ctx || this.ctx.state !== "running") return;
      const ctx = this.ctx, t = ctx.currentTime, len = 1.1;
      const noise = ctx.createBufferSource();
      noise.buffer = this._impulse(len, 0.2);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 1.4;
      band.frequency.setValueAtTime(up ? 350 : 2400, t);
      band.frequency.exponentialRampToValueAtTime(up ? 2400 : 350, t + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + len * 0.45);
      g.gain.linearRampToValueAtTime(0, t + len);
      noise.connect(band).connect(g);
      g.connect(this.ui);
      g.connect(this.reverb);
      noise.start(t);
      noise.stop(t + len);
    }
  }

  window.Ambient = Ambient;
})();
