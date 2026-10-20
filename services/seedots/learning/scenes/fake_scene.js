const lr = kit.param("lr", {label: "Learning rate", min: 0.02, max: 1.1, step: 0.01, value: 0.1});
const {ctx, w, h} = kit.canvas();
const C = kit.colors, f = (x) => (x - 3) * (x - 3), X = (x) => 40 + (x + 1) / 8 * (w - 80), Y = (y) => h - 30 - y / 16 * (h - 60);
function draw() {
  const a = kit.get("lr");
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= 200; i++) { const x = -1 + 8 * i / 200; i ? ctx.lineTo(X(x), Y(f(x))) : ctx.moveTo(X(x), Y(f(x))); }
  ctx.stroke();
  let x = 0; const xs = [x];
  for (let k = 0; k < 30; k++) { x = x - a * 2 * (x - 3); xs.push(x); if (!isFinite(x) || Math.abs(x) > 1e6) break; }
  ctx.strokeStyle = C.pollen; ctx.beginPath();
  xs.forEach((v, i) => { const px = X(Math.max(-1, Math.min(7, v))), py = Y(Math.min(16, f(v))); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
  ctx.fillStyle = C.moss; xs.forEach((v) => { ctx.beginPath(); ctx.arc(X(Math.max(-1, Math.min(7, v))), Y(Math.min(16, f(v))), 4, 0, 7); ctx.fill(); });
  const d = xs.slice(1).map((v, i) => v - xs[i]); const last = Math.abs(d[d.length - 1] || 0);
  kit.observe("behaviour", !isFinite(x) || Math.abs(x) > 1e6 || last > Math.abs(d[Math.floor(d.length/2)]) * 1.5 && last > 0.05 ? "blows up" : (d.slice(-4).every((q, i, arr) => i === 0 || q * arr[i-1] < 0) && last > 0.05 ? "keeps bouncing" : "settles down"));
}
kit.onChange(draw); draw(); kit.ready();
