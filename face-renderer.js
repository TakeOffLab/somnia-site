import { ExpressiveMotion } from "./face-motion.js";
const ASSETS = "assets/face/expressive/";
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Face artwork unavailable"));
    image.src = src;
  });
export class FaceRenderer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "low-power",
    });
    if (!this.gl) throw new Error("WebGL 2 unavailable");
    this.fx = overlay.getContext("2d");
    this.motion = new ExpressiveMotion();
    this.state = {
      primary: "idle",
      mood: "calm",
      energy: "normal",
      effects: [],
    };
    this.visible = false;
    this.paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.raf = 0;
    this.lost = false;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      this.stop();
      canvas.closest(".face-stage").classList.remove("is-rendering");
    });
    canvas.addEventListener("webglcontextrestored", () => location.reload());
  }
  async init() {
    const [layout, shaders, base, ...eyes] = await Promise.all([
      fetch(ASSETS + "layout.json").then((r) => r.json()),
      fetch(ASSETS + "shaders.json").then((r) => r.json()),
      loadImage(ASSETS + "base.png"),
      ...["eye-0.png", "distance-0.png", "eye-1.png", "distance-1.png"].map(
        (n) => loadImage(ASSETS + n),
      ),
    ]);
    this.layout = layout;
    const gl = this.gl;
    this.canvas.width = 960;
    this.canvas.height = 540;
    this.overlay.width = 960;
    this.overlay.height = 540;
    this.sprite = this.program(shaders.sprite_vertex, shaders.sprite);
    this.eye = this.program(shaders.quad, shaders.eye);
    this.blur = this.program(shaders.quad, shaders.blur);
    this.base = this.texture(base);
    this.eyes = layout.eyes.map((r, i) => ({
      source: this.texture(eyes[i * 2]),
      distance: this.texture(eyes[i * 2 + 1]),
      eye: this.target(r.patch),
      blur: this.target(r.glow),
      glow: this.target(r.glow),
    }));
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.draw(performance.now() / 1000);
    this.canvas.closest(".face-stage").classList.add("is-rendering");
    const visibility = new Map();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          visibility.set(entry.target, entry.isIntersecting);
        this.visible = [...visibility.values()].some(Boolean);
        this.resume();
      },
      { rootMargin: "80px" },
    );
    const surfaces = this.canvas.hasAttribute("data-background-face")
      ? document.querySelectorAll(".hero, .article-hero, .thought-section")
      : [this.canvas];
    for (const surface of surfaces) this.observer.observe(surface);
    document.addEventListener("visibilitychange", () => this.resume());
  }
  program(vs, fs) {
    const gl = this.gl,
      program = gl.createProgram();
    for (const [kind, source] of [
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs],
    ]) {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    return { handle: program, locations: {} };
  }
  uniform(program, name, value, int = false) {
    const gl = this.gl;
    const loc =
      program.locations[name] ??
      (program.locations[name] = gl.getUniformLocation(program.handle, name));
    if (Array.isArray(value)) {
      gl["uniform" + value.length + "fv"](loc, value);
    } else if (int) gl.uniform1i(loc, value);
    else gl.uniform1f(loc, value);
  }
  texture(image, size) {
    const gl = this.gl,
      texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (image)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
    else
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        size[0],
        size[1],
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    return texture;
  }
  target(size) {
    const gl = this.gl,
      texture = this.texture(null, size),
      fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Face framebuffer unavailable");
    return { texture, fb, size };
  }
  bind(texture, slot = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }
  destination(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fb ?? null);
    gl.viewport(0, 0, ...(target?.size ?? [960, 540]));
  }
  spriteDraw(texture, rect, kind = 0, gain = 1, tint = [1, 1, 1]) {
    const gl = this.gl,
      p = this.sprite;
    gl.useProgram(p.handle);
    this.bind(texture);
    for (const [n, v] of Object.entries({
      rect,
      viewport: [960, 540],
      gain,
      tint,
    }))
      this.uniform(p, n, v);
    this.uniform(p, "image", 0, true);
    this.uniform(p, "kind", kind, true);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  draw(now) {
    if (this.lost) return;
    const gl = this.gl,
      poses = this.motion.sample(this.state, now);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    for (let i = 0; i < 2; i++) {
      const r = this.layout.eyes[i],
        b = this.eyes[i],
        pose = poses[i],
        p = this.eye;
      this.destination(b.eye);
      gl.useProgram(p.handle);
      this.bind(b.source);
      this.bind(b.distance, 1);
      this.uniform(p, "artwork", 0, true);
      this.uniform(p, "distance_field", 1, true);
      for (const [n, v] of Object.entries({
        patch_size: r.patch,
        eye_size: r.texture,
        shape: [pose.lid, pose.slant, pose.smile, r.outer],
        deform: [pose.width, pose.height, pose.openness, pose.tilt],
        light: [pose.light, pose.sparkle],
      }))
        this.uniform(p, n, v);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.useProgram(this.blur.handle);
      this.uniform(this.blur, "image", 0, true);
      const radius = r.texture[0] * 0.026;
      for (const [target, source, direction] of [
        [b.blur, b.eye.texture, [radius / r.patch[0], 0]],
        [b.glow, b.blur.texture, [0, radius / r.patch[1]]],
      ]) {
        this.destination(target);
        this.bind(source);
        this.uniform(this.blur, "direction", direction);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    this.destination(null);
    this.spriteDraw(this.base, [0, 0, 960, 540]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (let i = 0; i < 2; i++) {
      const r = this.layout.eyes[i],
        b = this.eyes[i],
        pose = poses[i],
        rect = [
          r.center[0] + pose.x * 0.5 - r.patch[0] / 2,
          r.center[1] + pose.y * 0.5 - r.patch[1] / 2,
          ...r.patch,
        ];
      this.spriteDraw(b.glow.texture, rect, 1, 0.55 * pose.light, r.tint);
      this.spriteDraw(b.eye.texture, rect);
    }
    this.drawEffects(this.motion.effectFrame(), poses);
  }
  drawEffects(f, poses) {
    const active = Object.values(f).some((v) => v[0] > 0.015);
    if (!active && !this.hadEffects) return;
    this.hadEffects = active;
    const ctx = this.fx;
    ctx.clearRect(0, 0, 960, 540);
    const add = (x, y, w, h, color, a, kind, angle = 0, param = 0) => {
      if (a <= 0.015) return;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.scale(w / 2, h / 2);
      ctx.globalAlpha = Math.min(1, a);
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.lineWidth = kind === "ray" ? 0.26 : kind === "check" ? 0.21 : 0.13;
      ctx.beginPath();
      if (kind === "star") {
        ctx.moveTo(0, -0.64);
        ctx.lineTo(0.15, -0.15);
        ctx.lineTo(0.64, 0);
        ctx.lineTo(0.15, 0.15);
        ctx.lineTo(0, 0.64);
        ctx.lineTo(-0.15, 0.15);
        ctx.lineTo(-0.64, 0);
        ctx.lineTo(-0.15, -0.15);
        ctx.closePath();
        ctx.fill();
      } else if (kind === "ray") {
        ctx.moveTo(0, -0.42);
        ctx.lineTo(0, 0.42);
        ctx.stroke();
      } else if (kind === "circle") {
        ctx.lineWidth = 0.065;
        ctx.arc(0, 0, 0.67, 0, Math.PI * 2);
        ctx.stroke();
      } else if (kind === "check") {
        ctx.moveTo(-0.4, 0.01);
        ctx.lineTo(-0.12, 0.3);
        ctx.lineTo(0.43, -0.33);
        ctx.stroke();
      } else if (kind === "bang") {
        ctx.lineWidth = 0.22;
        ctx.moveTo(0, -0.47);
        ctx.lineTo(0, 0.05);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0.43, 0.13, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = 0.05;
        ctx.arc(
          0,
          0,
          0.67,
          param < 0 ? Math.PI - 1.05 : -1.05,
          param < 0 ? Math.PI + 1.05 : 1.05,
        );
        ctx.stroke();
      }
      ctx.restore();
    };
    this.layout.eyes.forEach((r, i) => {
      const side = i ? 1 : -1,
        pose = poses[i],
        cx = r.center[0] + pose.x * 0.5,
        cy = r.center[1] + pose.y * 0.5,
        [w, h] = r.texture,
        accent = i ? "#d187ff" : "#59f2ff",
        white = "#f7ffff";
      let [a, p] = f.surprise ?? [0, 0];
      if (a) {
        for (const offset of [-0.55, 0, 0.55]) {
          const theta = -Math.PI / 2 + side * 0.6 + offset;
          add(
            cx + Math.cos(theta) * w * (0.52 + p * 0.12),
            cy + Math.sin(theta) * h * (0.52 + p * 0.12),
            w * 0.15,
            h * 0.29,
            white,
            a,
            "ray",
            theta + Math.PI / 2,
          );
        }
        if (!i)
          add(
            cx + w * 0.6,
            cy - h * 0.43,
            w * 0.27,
            h * 0.46,
            "#ffe37d",
            a,
            "bang",
          );
      }
      [a, p] = f.celebration ?? [0, 0];
      if (a)
        [-2.7, -1.4, 0.05].forEach((angle, j) => {
          const theta = i ? Math.PI - angle : angle,
            spread = 0.52 + p * 0.21,
            scale =
              (j === 1 ? 0.3 : 0.21) * (0.8 + 0.2 * Math.sin(p * Math.PI));
          add(
            cx + Math.cos(theta) * w * spread,
            cy + Math.sin(theta) * h * spread - p * h * 0.14,
            w * scale,
            w * scale,
            j === 1 ? "#ffeba1" : white,
            a,
            "star",
            side * (p - 0.3) * 0.55,
          );
        });
      [a, p] = f.ack ?? [0, 0];
      if (a && i) {
        const x = cx + w * 0.42,
          y = cy - h * (0.38 + p * 0.09),
          s = w * (0.36 + p * 0.025);
        add(x, y, s, s, accent, a * 0.75, "circle");
        add(x, y, s * 0.82, s * 0.82, white, a, "check");
      }
      [a, p] = f.beacon ?? [0, 0];
      if (a)
        for (const offset of [0, 0.5]) {
          const phase = (p + offset) % 1,
            extent = w * (1.55 + phase * 0.6);
          add(
            cx,
            cy,
            extent,
            extent,
            accent,
            Math.sin(Math.PI * phase) ** 1.5 * a * 0.92,
            "arc",
            0,
            side,
          );
        }
    });
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  resume() {
    this.stop();
    this.motion.last = null;
    if (this.paused || !this.visible || document.hidden || this.lost) return;
    const frame = (t) => {
      this.draw(t / 1000);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  setState(state) {
    const changed = JSON.stringify(state) !== JSON.stringify(this.state);
    this.state = state;
    if (this.paused && changed) {
      this.motion.last = null;
      this.motion.sample(state, performance.now() / 1000);
      for (let i = 0; i < 100; i++)
        this.motion.sample(state, performance.now() / 1000 + i / 60);
      this.draw(performance.now() / 1000 + 2);
      this.fx.clearRect(0, 0, 960, 540);
    }
  }
}
