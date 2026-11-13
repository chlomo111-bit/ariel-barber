const css=`@font-face{font-family:H;src:url(heebo-hebrew-400-normal.woff2);font-weight:400;unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F}
@font-face{font-family:H;src:url(heebo-latin-400-normal.woff2);font-weight:400}
@font-face{font-family:H;src:url(heebo-hebrew-700-normal.woff2);font-weight:700;unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F}
@font-face{font-family:H;src:url(heebo-latin-700-normal.woff2);font-weight:700}
@font-face{font-family:H;src:url(heebo-hebrew-900-normal.woff2);font-weight:900;unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F}
@font-face{font-family:H;src:url(heebo-latin-900-normal.woff2);font-weight:900}
*{margin:0;box-sizing:border-box}body{font-family:H,sans-serif;direction:rtl;color:#f3ead7}
.s{position:relative;overflow:hidden;background:radial-gradient(120% 80% at 50% 0%,#2a2010 0%,#0d0b08 60%);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.s::before{content:"";position:absolute;left:0;right:0;top:0;height:18px;background:repeating-linear-gradient(-45deg,#c9a255 0 22px,#0d0b08 22px 44px)}
.s::after{content:"";position:absolute;inset:40px;border:2px solid rgba(201,162,85,.35);border-radius:36px;pointer-events:none}
.logo{width:150px;height:150px;border-radius:50%;}
.g{color:#e3c27e}.top{position:absolute;top:80px;font-size:30px;letter-spacing:.25em;color:#c9a255;font-weight:700}
.bot{position:absolute;bottom:80px;font-size:30px;color:#a89e8a;direction:ltr}
.stars{font-size:64px;color:#e3c27e;letter-spacing:.08em}
.q{font-size:58px;font-weight:700;line-height:1.35;max-width:860px}
.who{margin-top:40px;font-size:40px;font-weight:900;color:#e3c27e}
.qm{font-size:200px;line-height:.6;color:rgba(201,162,85,.35);font-weight:900;height:110px}`;
module.exports=(w,h,body)=>`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="s" style="width:${w}px;height:${h}px">${body}</div></body></html>`;
