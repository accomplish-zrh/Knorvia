'use strict';

// The window is a view of the running host. Closing it must not cancel the
// daemon, media workers, or CLI callers. Explicit Quit still shuts down once.
function keepWindowInBackground(window, canRemainRunning) {
  const close = event => {
    if (!canRemainRunning()) return;
    event.preventDefault();
    window.hide();
  };
  window.on('close', close);
  return () => window.removeListener('close', close);
}

module.exports = { keepWindowInBackground };
