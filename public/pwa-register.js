/* Registro del Service Worker con guardas:
 * - NO se registra en iframes (preview del editor Lovable).
 * - NO se registra en hosts de preview de Lovable (lovableproject.com, id-preview--).
 * - Solo se activa en producción servida desde el dominio publicado / instalada.
 *
 * Actualización silenciosa: cuando hay una versión nueva del Service Worker,
 * se activa sola (skipWaiting en sw.js) y aquí recargamos la página una sola
 * vez en cuanto toma el control. Así el usuario nunca ve el botón
 * "Actualizar" de Chrome/Safari: la app pasa a la versión nueva sin preguntar.
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

    if ("serviceWorker" in navigator) {
      // Marca de sesión: evita recargas en bucle si el SW cambia varias veces.
      var reloaded = sessionStorage.getItem("sw-reloaded") === "1";

      // Recarga automática y silenciosa cuando un SW nuevo toma el control.
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (!reloaded) {
          sessionStorage.setItem("sw-reloaded", "1");
          window.location.reload();
        }
      });

      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {});
      });
    }
  } catch (e) {
    /* no-op */
  }
})();

