// Rend des visuels aux couleurs d'Ariel (noir + or, Heebo).
// Usage : node ig/kit/render.js spec.json   → écrit les .jpg dans ig/out/
// spec.json = [{"name":"st-1511","w":1080,"h":1920,"body":"<html du contenu>"}, ...]
// Dans body : HEAD (bandeau du haut), FOOT (@ariel.zarbakhsh), LOGO (logo rond) sont remplacés.
// Classes utiles : .q (texte centré), .g (or), .stars, .who, .qm (guillemet).
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const T = require("./tpl.js");
const KIT = __dirname, OUT = path.join(KIT, "..", "out");
const HEAD = '<div class="top">• ARIEL · BARBER · חולון •</div>';
const FOOT = '<div class="bot">@ariel.zarbakhsh</div>';
const LOGO = '<img class="logo" src="icon-512.png" style="width:200px;height:200px">';
(async () => {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch(), p = await b.newPage();
  for (const s of spec) {
    const body = s.body.replace(/HEAD/g, HEAD).replace(/FOOT/g, FOOT).replace(/LOGO/g, LOGO);
    const f = path.join(KIT, "_" + s.name + ".html");
    fs.writeFileSync(f, T(s.w || 1080, s.h || 1920, body));
    await p.setViewportSize({ width: s.w || 1080, height: s.h || 1920 });
    await p.goto("file://" + f); await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, s.name + ".jpg"), type: "jpeg", quality: 92 });
    fs.unlinkSync(f);
    console.log("ok", path.join("ig/out", s.name + ".jpg"));
  }
  await b.close();
})();
