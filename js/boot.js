(function () {
  var shown = false;
  function fail() {
    if (shown || window.__booted) return;
    var main = document.getElementById("main");
    if (!main) { document.addEventListener("DOMContentLoaded", fail); return; }
    shown = true;
    var note = document.getElementById("bootNote");
    if (note) note.remove();
    main.insertAdjacentHTML("afterbegin", '<div class="page" id="bootFail"><div class="banner err"><b>Приложение не загрузилось.</b> Нет связи с сайтом или файл пришёл с ошибкой. Проверьте интернет и попробуйте ещё раз.</div><div class="btns"><button type="button" class="btn" id="bootRetry">Попробовать ещё раз</button></div></div>');
    document.getElementById("bootRetry").addEventListener("click", function () { location.reload(); });
  }
  window.__bootFail = fail;
  addEventListener("error", function (e) {
    var t = e.target;
    if ((t && t.tagName === "SCRIPT" && /js\/app\.js/.test(t.src || "")) || (e.filename && /\/js\/[\w-]+\.js/.test(e.filename) && e.error instanceof SyntaxError)) fail();
  }, true);
})();
