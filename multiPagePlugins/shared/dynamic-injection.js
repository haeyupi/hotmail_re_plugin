(function attachDynamicInjectionHelpers(globalScope) {
  function shouldSkipDynamicInjection(options = {}) {
    const {
      sameUrl = false,
      reloadIfSameUrl = false,
      hashOnlyNavigation = false,
      contentScriptResponsive = false,
    } = options;

    if (!contentScriptResponsive) {
      return false;
    }

    if (sameUrl) {
      return !reloadIfSameUrl;
    }

    return Boolean(hashOnlyNavigation);
  }

  const api = {
    shouldSkipDynamicInjection,
  };

  globalScope.MultiPageDynamicInjection = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
