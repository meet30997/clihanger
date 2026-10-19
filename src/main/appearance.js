'use strict';

const FALLBACK = Object.freeze({
  effectiveAppearance: 'light',
  selectionBackground: '#b3d7ff',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#dcdce0',
});

function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const match = value.trim().match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

function readAppearance(systemPreferences, nativeTheme) {
  const effectiveAppearance = 'light';

  const readColor = (name, fallback) => {
    try { return normalizeColor(systemPreferences.getColor(name), fallback); } catch { return fallback; }
  };

  return {
    effectiveAppearance,
    selectionBackground: readColor('selected-text-background', FALLBACK.selectionBackground),
    selectionForeground: readColor('selected-text', FALLBACK.selectionForeground),
    selectionInactiveBackground: readColor(
      'unemphasized-selected-text-background',
      FALLBACK.selectionInactiveBackground
    ),
  };
}

function sameAppearance(a, b) {
  return a.effectiveAppearance === b.effectiveAppearance
    && a.selectionBackground === b.selectionBackground
    && a.selectionForeground === b.selectionForeground
    && a.selectionInactiveBackground === b.selectionInactiveBackground;
}

function observeAppearance({ systemPreferences, nativeTheme, onChange }) {
  let current = readAppearance(systemPreferences, nativeTheme);
  let colorSubscription = null;

  const refresh = () => {
    const next = readAppearance(systemPreferences, nativeTheme);
    if (sameAppearance(current, next)) return;
    current = next;
    onChange(next);
  };

  nativeTheme.on('updated', refresh);
  if (process.platform === 'darwin') {
    colorSubscription = systemPreferences.subscribeNotification(
      'AppleColorPreferencesChangedNotification',
      refresh
    );
  }

  return {
    current: () => current,
    stop: () => {
      nativeTheme.removeListener('updated', refresh);
      if (colorSubscription !== null) {
        systemPreferences.unsubscribeNotification(colorSubscription);
        colorSubscription = null;
      }
    },
  };
}

module.exports = { FALLBACK, normalizeColor, readAppearance, sameAppearance, observeAppearance };
