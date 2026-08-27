/* Registro robusto del Service Worker para producción.
 * - No se registra en previews/iframes de Lovable.
 * - Fuerza la comprobación del SW sin usar caché HTTP.
 * - Recarga una sola vez por cambio real de controller (guardia en memoria,
 *   no sessionStorage, porque iOS puede conservar la sesión de una PWA instalada).
 * - Vuelve a comprobar actualizaciones al abrir/volver a primer plano.
 */
(function () {
  try {
    var inIframe = false;
    try {
      inIframe = window.self !== window.top;
    } catch (e) {
      inIframe = true;
    }

    var host = window.location.hostname || "";
    var isPreviewHost =
      host.indexOf("id-preview--") !== -1 ||
      host.indexOf("lovableproject.com") !== -1 ||
      host.indexOf("lovable.dev") !== -1;

    if (inIframe || isPreviewHost) {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then(function (regs) {
            regs.forEach(function (r) {
              r.unregister();
            });
          })
          .catch(function () {});
      }
      return;
    }

    if (!("serviceWorker" in navigator)) return;

    var refreshing = false;
    var registration = null;

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    function checkForUpdate() {
      if (!registration) return;
      registration.update().catch(function () {});
    }

    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        })
        .then(function (reg) {
          registration = reg;
          checkForUpdate();
        })
        .catch(function () {});
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") checkForUpdate();
    });

    window.addEventListener("focus", checkForUpdate);
    window.setInterval(checkForUpdate, 30 * 60 * 1000);
  } catch (e) {
    /* no-op */
  }
})();
