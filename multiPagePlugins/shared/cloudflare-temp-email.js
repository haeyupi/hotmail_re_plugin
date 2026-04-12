(function attachCloudflareTempEmailHelpers(globalScope) {
  const PRIMARY_LOCAL_PART_WORD_BANKS = [
    [
      'anew', 'brisk', 'candid', 'fervent', 'gentle',
      'humble', 'jovial', 'kindly', 'lucid', 'mellow',
      'nimble', 'open', 'polished', 'quick', 'rosy',
      'steady', 'tidy', 'upbeat', 'vantage', 'thunderous',
    ],
    [
      'angled', 'bordered', 'crisp', 'eager', 'frozen',
      'golden', 'dotted', 'hushed', 'jagged', 'layered',
      'mellowed', 'narrow', 'opal', 'primal', 'quiet',
      'rippled', 'sunlit', 'trimmed', 'velvet', 'thumping',
    ],
    [
      'anchor', 'beacon', 'cinder', 'drifter', 'ember',
      'meadow', 'nickel', 'orbit', 'prairie', 'quartz',
      'rivet', 'latch', 'signal', 'thicket', 'uplift',
      'voyager', 'willow', 'yonder', 'zephyr', 'wilderness',
    ],
  ];
  const EXTENDED_LOCAL_PART_WORD_BANKS = [
    ['aurora', 'breezy', 'copper', 'drizzle', 'whimsy', 'glimmer', 'sapphire', 'harbor', 'inkwell', 'juniper'],
    ['almond', 'bronzed', 'cobbled', 'dappled', 'marbled', 'northern', 'moonlit', 'orchard', 'plaited', 'radiant'],
    ['acorn', 'bramble', 'citadel', 'daybreak', 'solstice', 'harvest', 'treeline', 'updraft', 'wildfire', 'yearling'],
  ];
  const MID_EXTENDED_LOCAL_PART_WORD_BANKS = [
    [
      'citrine', 'dapper', 'elmwood', 'feather', 'gossamer',
      'halcyon', 'ivory', 'kestrel', 'lively', 'mistral',
    ],
    [
      'lantern', 'mosaic', 'notched', 'oaken', 'pearled',
      'quilted', 'rusted', 'silken', 'tapered', 'umber',
    ],
    [
      'meridian', 'northstar', 'overlook', 'peninsula', 'quickstep',
      'ridgeline', 'starling', 'turnpike', 'undertow', 'vale',
    ],
  ];
  const TOP_EXTENDED_LOCAL_PART_WORD_BANKS = [
    ['whimsy', 'afterglow', 'birdsong', 'clearwater', 'dreamscape', 'everbright', 'firecrest', 'hinterland', 'isleward', 'keystone'],
    ['marbled', 'auric', 'blossomed', 'celestial', 'dawnlit', 'embered', 'frosted', 'gilded', 'heartland', 'ironbound'],
    ['solstice', 'airstream', 'brightside', 'crestfall', 'dovetail', 'elmshade', 'fieldstone', 'goldleaf', 'highwater', 'ivytrail'],
  ];
  const HIGH_EXTENDED_LOCAL_PART_WORD_BANKS = [
    [
      'adrift', 'bellwether', 'cedar', 'daystar', 'emberglow',
      'fjord', 'glasswing', 'horizon', 'islander', 'jetstream',
      'kingsley', 'longview', 'moonrise', 'northbound', 'oakleaf',
      'pinelight', 'quasar', 'runestone', 'seaborne', 'trailhead',
    ],
    [
      'bronzed', 'cobbled', 'drifted', 'etched', 'fernlike',
      'granulated', 'honeyed', 'indigo', 'jadeite', 'kindled',
      'lacquered', 'measured', 'navy', 'opaline', 'painted',
      'quenched', 'reeded', 'sanded', 'tempered', 'uplifted',
    ],
    [
      'cosmos', 'drumbeat', 'everglade', 'fjordline', 'grove',
      'headland', 'icefield', 'journey', 'knoll', 'lagoon',
      'moorland', 'narrows', 'outpost', 'passage', 'quarry',
      'riverbend', 'shoal', 'tideline', 'upland', 'vista',
    ],
  ];
  const APEX_EXTENDED_LOCAL_PART_WORD_BANKS = [
    [
      'atlas', 'bluebird', 'crestline', 'dewdrop', 'eastwind',
      'flare', 'glen', 'harvestmoon', 'iris', 'joyride',
      'kindred', 'larkspur', 'midway', 'nightfall', 'overture',
      'prairiesky', 'quill', 'rosewood', 'sunflare', 'turnstone',
      'uplight', 'violet', 'wildwood', 'xylia', 'yearbright',
      'zenway', 'amberline', 'brightshore', 'cloudrest', 'dawnsong',
    ],
    [
      'bronze', 'coppered', 'dawnwashed', 'everspun', 'firelit',
      'glazed', 'harbored', 'ivied', 'jade', 'keelmarked',
      'leafed', 'misted', 'nacre', 'oakmoss', 'pearlstone',
      'quartzite', 'rainsoft', 'sunwashed', 'timbered', 'umbered',
      'velour', 'windcut', 'xanthic', 'yellowed', 'zestful',
      'ashen', 'brightened', 'coasted', 'deepwater', 'emberlit',
    ],
    [
      'cosmos', 'daybreak', 'evercrest', 'fieldpath', 'groveside',
      'hilltop', 'inlet', 'junction', 'keyway', 'lakeside',
      'moonpath', 'nest', 'oakridge', 'portside', 'quayside',
      'riverside', 'stonepath', 'trailway', 'uplook', 'valecrest',
      'woodline', 'xylogrove', 'yardarm', 'zenithal', 'aircrest',
      'bayshore', 'crossing', 'driftway', 'elmtrail', 'foreside',
    ],
  ];
  const BASE_EXTENDED_WORD_RANGE_START = 0.91;
  const MID_EXTENDED_WORD_RANGE_START = 0.95;
  const TOP_EXTENDED_WORD_RANGE_START = 0.97;
  const HIGH_EXTENDED_WORD_RANGE_START = 0.985;
  const APEX_EXTENDED_WORD_RANGE_START = 0.993;

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function combineDistinctTextParts(parts = []) {
    const seen = new Set();
    const normalizedParts = [];

    for (const part of parts) {
      const value = normalizeWhitespace(part);
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      normalizedParts.push(value);
    }

    return normalizedParts.join(' ');
  }

  function normalizeText(value) {
    return normalizeWhitespace(value).toLowerCase();
  }

  function normalizeEmail(value) {
    return normalizeText(value);
  }

  function normalizeDomainSuffix(value) {
    const match = normalizeText(value).match(/@?([a-z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1].toLowerCase() : '';
  }

  function toFiniteNumber(value) {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function parseAdminTimestamp(value) {
    const match = normalizeWhitespace(value).match(
      /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );
    if (!match) return null;

    const [, year, month, day, hour, minute, second = '0'] = match;
    const timestamp = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime();

    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function extractVerificationCode(text) {
    const content = String(text || '');

    const matchCn = content.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
    if (matchCn) return matchCn[1];

    const matchEn = content.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
    if (matchEn) return matchEn[1] || matchEn[2];

    const match6 = content.match(/\b(\d{6})\b/);
    if (match6) return match6[1];

    return null;
  }

  function decodeBase64Url(segment) {
    const base64 = String(segment || '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const padded = base64 + padding;

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }

    if (typeof atob === 'function') {
      return atob(padded);
    }

    throw new Error('No base64 decoder available.');
  }

  function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;

    try {
      return JSON.parse(decodeBase64Url(parts[1]));
    } catch {
      return null;
    }
  }

  function parseCloudflareMailboxCredential(token) {
    const jwtMatch = String(token || '').match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (!jwtMatch) return null;

    const payload = decodeJwtPayload(jwtMatch[0]);
    const email = normalizeEmail(payload?.address || payload?.email || '');
    if (!email || !email.includes('@')) {
      return null;
    }

    const [localPart, ...domainParts] = email.split('@');
    const domain = domainParts.join('@');

    return {
      addressId: toFiniteNumber(payload?.address_id),
      domain,
      email,
      localPart,
      provenance: 'created',
    };
  }

  function pickWord(words, randomFn) {
    const randomValue = Math.max(0, Math.min(0.999999999999, Number(randomFn())));
    return words[Math.floor(randomValue * words.length)] || words[0];
  }

  function pickReadableWord(bankIndex, randomFn) {
    const randomValue = Math.max(0, Math.min(0.999999999999, Number(randomFn())));
    const primaryWords = PRIMARY_LOCAL_PART_WORD_BANKS[bankIndex] || [];
    const extendedWords = EXTENDED_LOCAL_PART_WORD_BANKS[bankIndex] || [];
    const midExtendedWords = MID_EXTENDED_LOCAL_PART_WORD_BANKS[bankIndex] || [];
    const topExtendedWords = TOP_EXTENDED_LOCAL_PART_WORD_BANKS[bankIndex] || [];
    const highExtendedWords = HIGH_EXTENDED_LOCAL_PART_WORD_BANKS[bankIndex] || [];
    const apexExtendedWords = APEX_EXTENDED_LOCAL_PART_WORD_BANKS[bankIndex] || [];

    if (apexExtendedWords.length > 0 && randomValue >= APEX_EXTENDED_WORD_RANGE_START) {
      const apexExtendedSpan = 1 - APEX_EXTENDED_WORD_RANGE_START;
      const apexExtendedValue = Math.min(0.999999999999, (randomValue - APEX_EXTENDED_WORD_RANGE_START) / apexExtendedSpan);
      return pickWord(apexExtendedWords, () => apexExtendedValue);
    }

    if (highExtendedWords.length > 0 && randomValue >= HIGH_EXTENDED_WORD_RANGE_START) {
      const highExtendedSpan = APEX_EXTENDED_WORD_RANGE_START - HIGH_EXTENDED_WORD_RANGE_START;
      const highExtendedValue = Math.min(0.999999999999, (randomValue - HIGH_EXTENDED_WORD_RANGE_START) / highExtendedSpan);
      return pickWord(highExtendedWords, () => highExtendedValue);
    }

    if (topExtendedWords.length > 0 && randomValue >= TOP_EXTENDED_WORD_RANGE_START) {
      const topExtendedSpan = HIGH_EXTENDED_WORD_RANGE_START - TOP_EXTENDED_WORD_RANGE_START;
      const topExtendedValue = Math.min(0.999999999999, (randomValue - TOP_EXTENDED_WORD_RANGE_START) / topExtendedSpan);
      return pickWord(topExtendedWords, () => topExtendedValue);
    }

    if (midExtendedWords.length > 0 && randomValue >= MID_EXTENDED_WORD_RANGE_START) {
      const midExtendedSpan = TOP_EXTENDED_WORD_RANGE_START - MID_EXTENDED_WORD_RANGE_START;
      const midExtendedValue = Math.min(0.999999999999, (randomValue - MID_EXTENDED_WORD_RANGE_START) / midExtendedSpan);
      return pickWord(midExtendedWords, () => midExtendedValue);
    }

    if (extendedWords.length > 0 && randomValue >= BASE_EXTENDED_WORD_RANGE_START) {
      const extendedSpan = MID_EXTENDED_WORD_RANGE_START - BASE_EXTENDED_WORD_RANGE_START;
      const extendedValue = Math.min(0.999999999999, (randomValue - BASE_EXTENDED_WORD_RANGE_START) / extendedSpan);
      return pickWord(extendedWords, () => extendedValue);
    }

    return pickWord(primaryWords, () => randomValue);
  }

  function generateReadableLocalPart(randomFn = Math.random, maxLength = 24) {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const value = PRIMARY_LOCAL_PART_WORD_BANKS
        .map((_, bankIndex) => pickReadableWord(bankIndex, randomFn))
        .join('-');

      if (value.length <= maxLength) {
        return value;
      }
    }

    return 'anew-dotted-latch';
  }

  function pickRandomSuffix(options = [], randomFn = Math.random) {
    const seen = new Set();
    const suffixes = [];

    for (const option of options) {
      const suffix = normalizeDomainSuffix(option);
      if (!suffix || seen.has(suffix)) {
        continue;
      }
      seen.add(suffix);
      suffixes.push(suffix);
    }

    if (suffixes.length === 0) {
      return '';
    }

    return pickWord(suffixes, randomFn);
  }

  function compareMessageIds(left, right) {
    const leftNumber = toFiniteNumber(left);
    const rightNumber = toFiniteNumber(right);

    if (leftNumber !== null && rightNumber !== null) {
      return rightNumber - leftNumber;
    }

    return String(right || '').localeCompare(String(left || ''));
  }

  function selectVerificationMessage(messages = [], options = {}) {
    const targetEmail = normalizeEmail(options.targetEmail || '');
    const senderFilters = (options.senderFilters || []).map(normalizeText);
    const subjectFilters = (options.subjectFilters || []).map(normalizeText);
    const filterAfterTimestamp = toFiniteNumber(options.filterAfterTimestamp) || 0;
    const candidates = [];

    for (const message of messages) {
      const matchedEmail = normalizeEmail(message?.matchedEmail || message?.toEmail || '');
      if (targetEmail && matchedEmail && matchedEmail !== targetEmail) {
        continue;
      }
      if (targetEmail && !matchedEmail) {
        continue;
      }

      const subject = normalizeWhitespace(message?.subject || '');
      const combinedText = normalizeWhitespace(message?.combinedText || '');
      const sender = normalizeText(message?.sender || '');
      const searchText = normalizeText(`${subject} ${combinedText}`);
      const code = extractVerificationCode(`${subject} ${combinedText}`);
      if (!code) {
        continue;
      }

      const senderMatch = senderFilters.length === 0
        || senderFilters.some((filter) => sender.includes(filter) || searchText.includes(filter));
      const subjectMatch = subjectFilters.length === 0
        || subjectFilters.some((filter) => normalizeText(subject).includes(filter) || searchText.includes(filter));

      if (!senderMatch && !subjectMatch) {
        continue;
      }

      const emailTimestamp = toFiniteNumber(message?.emailTimestamp)
        || parseAdminTimestamp(message?.timestampText || '');

      if (filterAfterTimestamp > 0 && (!emailTimestamp || emailTimestamp <= filterAfterTimestamp)) {
        continue;
      }

      candidates.push({
        code,
        emailTimestamp: emailTimestamp || 0,
        matchedEmail,
        messageId: message?.messageId ?? null,
        subject: subject || null,
      });
    }

    candidates.sort((left, right) => {
      if (left.emailTimestamp !== right.emailTimestamp) {
        return right.emailTimestamp - left.emailTimestamp;
      }
      return compareMessageIds(left.messageId, right.messageId);
    });

    return candidates[0] || null;
  }

  const api = {
    combineDistinctTextParts,
    extractVerificationCode,
    generateReadableLocalPart,
    normalizeDomainSuffix,
    parseAdminTimestamp,
    parseCloudflareMailboxCredential,
    pickRandomSuffix,
    selectVerificationMessage,
  };

  globalScope.MultiPageCloudflareTempEmail = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
