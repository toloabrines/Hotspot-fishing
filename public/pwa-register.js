/* Hotspot Fishing — limpieza PWA para iOS.
 * Desactiva el service worker y elimina sus cachés de aplicación para evitar
 * que la app instalada en pantalla de inicio cargue JS/CSS antiguos. Conserva
 * únicamente los datos batimétricos; el manifest permite abrir la web como app
 * standalone, pero los archivos de la aplicación siempre llegan desde red.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  // Esta caché contiene únicamente bloques batimétricos ya consultados. No
  // guarda JS/CSS de la aplicación, por lo que conservarla no puede mostrar
  // una versión antigua y acelera las zonas que el usuario vuelve a visitar.
  var PERSISTENT_DATA_CACHES = ["dem-json-v1"];

  window.addEventListener("load", function () {
    (async function () {
      try {
        var hadController = !!navigator.serviceWorker.controller;

        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          regs.map(function (reg) {
            return reg.unregister();
          }),
        );

        if ("caches" in window) {
          var keys = await caches.keys();
          await Promise.all(
            keys
              .filter(function (key) {
                return PERSISTENT_DATA_CACHES.indexOf(key) === -1;
              })
              .map(function (key) {
                return caches.delete(key);
              }),
          );
        }

        // Si esta ventana aún estaba controlada por el SW antiguo, una sola
        // recarga libera el control y fuerza una carga limpia desde la red.
        if (hadController && !sessionStorage.getItem("hotspot-pwa-reset-1.1.3")) {
          sessionStorage.setItem("hotspot-pwa-reset-1.1.3", "1");
          window.location.reload();
        }
      } catch (e) {
        // No bloquear nunca el arranque de la aplicación.
      }
    })();
  });
})();
