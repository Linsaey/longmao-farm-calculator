// ==UserScript==
// @name         龙猫放置 · 挂机收益采集桥
// @namespace    https://github.com/Linsaey/longmao-farm-calculator
// @version      1.0.0
// @description  在游戏里读取真实队伍属性（按客户端公式从存档推算），并按地图采样经验/金币收益；把数据交给「挂机收益计算器」页面
// @match        http://43.142.100.84:8080/*
// @match        https://linsaey.github.io/longmao-farm-calculator/*
// @match        https://linsaey.github.io/longmao-farm-calculator/index.html*
// @match        https://aka.doubaocdn.com/s/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
/* global GM, GM_getValue, GM_setValue */

(function () {
  'use strict';

  var CFG = {
    // 计算器页面地址：仓库改名/换域名时只改这一行
    pageUrl: 'https://linsaey.github.io/longmao-farm-calculator/',
    tickMs: 45000,          // 采样间隔
    maxGapSec: 400,         // 超过这个间隔的采样视为断档，丢弃
    statRefreshMs: 600000,  // 属性重算间隔
    key: 'lmBridge',
    tableVer: '1794598906629'
  };

  /* ================= GM 存储兼容层 ================= */
  function stGet(key, def) {
    return new Promise(function (resolve) {
      try {
        if (typeof GM_getValue === 'function') {
          var v = GM_getValue(key, def);
          var val = v;
          if (typeof v === 'string') { try { val = JSON.parse(v); } catch (e) { val = v; } }
          return resolve(val === undefined ? def : val);
        }
        if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') {
          return GM.getValue(key, def).then(function (v) {
            if (typeof v === 'string') { try { resolve(JSON.parse(v)); } catch (e) { resolve(v); } }
            else resolve(v === undefined ? def : v);
          }, function () { resolve(def); });
        }
      } catch (e) { }
      try {
        var s = localStorage.getItem('lmb_' + key);
        resolve(s ? JSON.parse(s) : def);
      } catch (e2) { resolve(def); }
    });
  }
  function stSet(key, val) {
    var payload = typeof val === 'string' ? val : JSON.stringify(val);
    return new Promise(function (resolve) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, payload); return resolve(true); }
        if (typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function') {
          return GM.setValue(key, payload).then(function () { resolve(true); }, function () { resolve(false); });
        }
      } catch (e) { }
      try { localStorage.setItem('lmb_' + key, payload); resolve(true); } catch (e2) { resolve(false); }
    });
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function log() {
    try { console.log.apply(console, ['[龙猫收益桥]'].concat([].slice.call(arguments))); } catch (e) { }
  }

  /* ================= 客户端属性公式（逐条复刻） ================= */
  // zd(): 力量/魔力/体力/幸运 → 衍生属性
  function zd(o) {
    var vit = num(o.vitality), luck = num(o.luck);
    var str = Math.max(num(o.strength), num(o.magic));
    return {
      hp: vit * 6,
      physicalReduction: vit * 0.8,
      magicReduction: vit * 0.8,
      defense: vit * 0.1,
      magicResist: vit * 0.1,
      critRate: (luck / 30) * 0.01,
      critDamage: luck * (0.01 / 30),
      hitRate: luck * (0.01 * 0.3 / 30),
      attackSpeed: str * 1e-4
    };
  }
  var ROUND_KEYS = ['strength', 'vitality', 'magic', 'luck', 'hp', 'mp', 'minAttack', 'maxAttack',
    'minMagicAttack', 'maxMagicAttack', 'physicalReduction', 'magicReduction', 'defense', 'magicResist'];
  var NEED_ZERO = ['goldRate', 'damageBonus', 'skillDamageBonus', 'physicalDamage', 'magicDamage'];

  function roundSome(o) {
    ROUND_KEYS.forEach(function (k) {
      if (typeof o[k] === 'number' && isFinite(o[k])) o[k] = Math.round(o[k]);
    });
    return o;
  }
  // Bd(): 把 zd() 的衍生值加到最终属性上
  function bd(stats, d) {
    if (!stats || !d) return stats;
    var pairs = [
      [stats.hpMax === undefined ? 'hp' : 'hpMax', d.hp],
      ['physicalReduction', d.physicalReduction], ['magicReduction', d.magicReduction],
      ['defense', d.defense], ['magicResist', d.magicResist],
      ['critRate', d.critRate], ['critDamage', d.critDamage],
      ['hitRate', d.hitRate], ['attackSpeed', d.attackSpeed]
    ];
    pairs.forEach(function (p) {
      if (typeof stats[p[0]] === 'number' && isFinite(p[1])) stats[p[0]] += p[1];
    });
    return stats;
  }
  // Gd(): 职业基础 + 每级成长
  function gd(classDef, level) {
    var out = {};
    var base = classDef.base || {};
    var growth = classDef.growth || {};
    var r = Math.max(0, level - 1);
    Object.keys(base).forEach(function (k) {
      out[k] = num(base[k]) + (growth[k] === undefined ? 0 : num(growth[k]) * r);
    });
    return roundSome(out);
  }
  // Kd(): 汇总所有来源（装备/词缀/套装/技能被动）
  function kd(baseStats, sources) {
    var s = {};
    Object.keys(baseStats).forEach(function (k) { s[k] = baseStats[k]; });
    NEED_ZERO.forEach(function (k) { if (s[k] === undefined) s[k] = 0; });
    var pct = {};
    sources.forEach(function (src) {
      if (!src) return;
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (v === null || v === undefined || !isFinite(Number(v))) return;
        v = Number(v);
        if (s[k] !== undefined) { s[k] += v; return; }
        var m = /^(.+?)percent$/i.exec(k);
        if (m) { pct[m[1]] = (pct[m[1]] || 0) + v; return; }
        s[k] = v;
      });
    });
    Object.keys(pct).forEach(function (k) {
      if (typeof s[k] === 'number') s[k] *= (1 + pct[k]);
    });
    bd(s, zd(s));
    roundSome(s);
    if (typeof s.minAttack === 'number' && typeof s.maxAttack === 'number' && s.minAttack > s.maxAttack) {
      s.minAttack = s.maxAttack;
    }
    if (typeof s.minMagicAttack === 'number' && typeof s.maxMagicAttack === 'number' && s.minMagicAttack > s.maxMagicAttack) {
      s.minMagicAttack = s.maxMagicAttack;
    }
    return s;
  }

  var ATTACK_STATS = { minAttack: 1, maxAttack: 1, minMagicAttack: 1, maxMagicAttack: 1 };
  function equipList(equip) {
    if (!equip) return [];
    if (Array.isArray(equip)) return equip.filter(Boolean);
    var out = [];
    Object.keys(equip).forEach(function (k) {
      var v = equip[k];
      if (Array.isArray(v)) v.forEach(function (x) { if (x) out.push(x); });
      else if (v && typeof v === 'object') out.push(v);
    });
    return out;
  }
  function itemIdOf(e) { return e && (e.itemId || e.id); }

  function statsFromProfile(profile, tables) {
    var cls = tables.classes.get(profile.classId);
    if (!cls) return null;
    var equips = equipList(profile.equip);
    var weaponTypes = {};
    equips.forEach(function (e) {
      var it = tables.items.get(itemIdOf(e));
      if (it && it.weaponType) weaponTypes[it.weaponType] = 1;
    });

    var sources = [];
    // 技能被动
    (profile.skills || []).forEach(function (sk) {
      var def = tables.skills.get(sk.skillId);
      if (!def || num(sk.level) <= 0) return;
      var lim = def.weaponLimit || [];
      if (lim.length) {
        var ok = false;
        lim.forEach(function (w) { if (weaponTypes[w]) ok = true; });
        if (!ok) return;
      }
      var lv = def.levels && def.levels[num(sk.level) - 1];
      if (!lv) return;
      (lv.passiveEffects || []).forEach(function (eff) {
        if (eff && eff.type && typeof eff.value === 'number') {
          var o = {}; o[eff.type] = eff.value; sources.push(o);
        }
      });
    });
    // 装备 + 词缀（攻击类词缀按百分比处理）
    equips.forEach(function (e) {
      var it = tables.items.get(itemIdOf(e));
      if (it && it.stats) sources.push(it.stats);
      (e.affixes || []).forEach(function (af) {
        if (!af || !af.stat || typeof af.value !== 'number') return;
        var o = {};
        o[ATTACK_STATS[af.stat] ? (af.stat + 'Percent') : af.stat] = af.value;
        sources.push(o);
      });
    });
    // 套装
    if (tables.setBonus && tables.setBonus.size) {
      var cnt = {};
      equips.forEach(function (e) {
        var it = tables.items.get(itemIdOf(e));
        if (it && it.setId) cnt[it.setId] = (cnt[it.setId] || 0) + 1;
      });
      Object.keys(cnt).forEach(function (sid) {
        var st = tables.setBonus.get(sid);
        if (!st) return;
        (st.tiers || []).forEach(function (t) {
          if (cnt[sid] >= num(t.pieces) && t.stats) sources.push(t.stats);
        });
      });
    }
    return kd(gd(cls, Math.max(1, Math.floor(num(profile.level) || 1))), sources);
  }

  function charFromProfile(profile, tables) {
    var stats = statsFromProfile(profile, tables);
    if (!stats) return null;
    var hp = num(stats.hpMax !== undefined ? stats.hpMax : stats.hp);
    var magic = num(stats.magic) > num(stats.strength);
    var cls = tables.classes.get(profile.classId) || {};
    return {
      name: String(profile.name || '我'),
      cls: profile.classId || '',
      clsName: String(cls.name || ''),
      lv: num(profile.level),
      mag: magic ? 1 : 0,
      hp: hp, mp: num(stats.mpMax !== undefined ? stats.mpMax : stats.mp),
      minA: num(stats.minAttack), maxA: num(stats.maxAttack),
      minMA: num(stats.minMagicAttack), maxMA: num(stats.maxMagicAttack),
      as: (num(stats.attackSpeed) || 1) * 100,
      cr: num(stats.critRate), cd: num(stats.critDamage) > 0 ? num(stats.critDamage) : 1.5,
      hit: num(stats.hitRate) > 0 ? num(stats.hitRate) : 1,
      dodge: num(stats.dodgeRate),
      def: num(stats.defense), mres: num(stats.magicResist),
      pRed: num(stats.physicalReduction), mRed: num(stats.magicReduction),
      ms: (num(stats.moveSpeed) || 1) * 100,
      goldRate: num(stats.goldRate),
      expMul: stats.expMultiplier === undefined ? 1 : num(stats.expMultiplier),
      // damageMultiplier 是职业技能的全局倍率（职业基础值 1 = 无加成），不能当加成项相加
      dmgBonus: num(stats.damageBonus) + Math.max(0, num(stats.damageMultiplier) - 1),
      str: num(stats.strength), magi: num(stats.magic),
      vit: num(stats.vitality), luck: num(stats.luck)
    };
  }

  /* ================= 表数据（同源 JSON，缓存一天） ================= */
  async function fetchJson(url) {
    var r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.json();
  }
  async function loadTables() {
    var cache = await stGet('tables', null);
    if (cache && cache.at && Date.now() - cache.at < 86400000 && cache.ver === CFG.tableVer) return revive(cache);
    var base = location.origin + '/data/';
    var q = '.json?v=' + CFG.tableVer;
    var [classes, items, sets, skills] = await Promise.all([
      fetchJson(base + 'classes' + q), fetchJson(base + 'items' + q),
      fetchJson(base + 'set_bonus' + q), fetchJson(base + 'skills' + q)
    ]);
    var pack = {
      at: Date.now(), ver: CFG.tableVer,
      classes: classes, items: items, setBonus: sets, skills: skills
    };
    stSet('tables', pack);
    return revive(pack);
  }
  function revive(pack) {
    function toMap(arr) {
      var m = new Map();
      (arr || []).forEach(function (x) { if (x && x.id !== undefined) m.set(x.id, x); });
      return m;
    }
    return {
      classes: toMap(pack.classes), items: toMap(pack.items),
      setBonus: toMap(pack.setBonus), skills: toMap(pack.skills)
    };
  }

  /* ================= 采样 ================= */
  function curMapId() {
    var h = location.hash || '';
    var m = h.match(/map\/([\w-]+)/) || h.match(/map=([\w-]+)/);
    return m ? m[1] : '';
  }

  function reduce(state, key, dtSec, dExp, dGold) {
    state.samples[key] = state.samples[key] || { sec: 0, exp: 0, gold: 0, since: Date.now() };
    var s = state.samples[key];
    s.sec = Math.min(36000, num(s.sec) + dtSec);
    s.exp = num(s.exp) + dExp;
    s.gold = num(s.gold) + dGold;
  }

  async function tick(state, tables, ui) {
    var body;
    try {
      body = await fetchJson(location.origin + '/api/profile');
    } catch (e) {
      ui.set('未登录或读不到存档');
      return state;
    }
    var p = body && body.profile;
    if (!p) { ui.set('存档为空'); return state; }
    var now = Date.now();
    var map = curMapId();
    var prev = state.last;

    if (prev && map && prev.map === map && prev.lv === num(p.level)) {
      var dt = (now - prev.t) / 1000;
      if (dt > 5 && dt < CFG.maxGapSec) {
        var dExp = num(p.exp) - prev.exp;
        var dGold = num(p.gold) - prev.gold;
        if (dGold < 0) dGold = 0;            // 花钱了就当 0
        if (dExp < 0) dExp = 0;              // 升级会清零经验
        reduce(state, map, dt, dExp, dGold);
      }
    }
    state.last = { t: now, map: map, lv: num(p.level), exp: num(p.exp), gold: num(p.gold) };
    state.at = now;

    // 属性：装备或等级变了就重算
    var sig = JSON.stringify({ c: p.classId, l: p.level, e: p.equip, s: p.skills });
    if (!state.char || state.sig !== sig || now - num(state.statAt) > CFG.statRefreshMs) {
      var ch = charFromProfile(p, tables);
      if (ch) {
        state.team = [ch];
        state.sig = sig;
        state.statAt = now;
      }
    }
    var mins = 0;
    Object.keys(state.samples).forEach(function (k) { mins += num(state.samples[k].sec) / 60; });
    ui.set('采集 ' + Math.round(mins) + ' 分钟 · ' + (map ? ('图 ' + map) : '未在图内'));
    return state;
  }

  /* ================= 页面侧：把数据交给计算器 ================= */
  function isPage() {
    return /github\.io/.test(location.host) || /longmao-farm-calculator/.test(location.pathname) ||
      /aka\.doubaocdn\.com/.test(location.host) ||
      typeof window.__lmAbsorb === 'function';
  }
  async function injectToPage() {
    var st = await stGet(CFG.key, null);
    if (!st || !st.team) return;
    var payload = { v: 1, at: st.at, team: st.team, samples: st.samples };
    var tries = 0;
    (function poke() {
      if (typeof window.__lmAbsorb === 'function') {
        try { window.__lmAbsorb(payload); } catch (e) { }
        return;
      }
      if (tries++ < 40) setTimeout(poke, 150);
    })();
  }

  async function pageUrlWithData() {
    var st = await stGet(CFG.key, null);
    var payload = { v: 1, at: st && st.at, team: st && st.team, samples: st && st.samples };
    return CFG.pageUrl + '#d=' + encodeURIComponent(JSON.stringify(payload));
  }

  function copyText(txt) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ================= 游戏侧浮标 UI ================= */
  function makePill() {
    var box = document.createElement('div');
    box.id = 'lm-bridge-pill';
    box.style.cssText = [
      'position:fixed', 'right:8px', 'bottom:96px', 'z-index:2147483000',
      'background:#14261a', 'border:1px solid #4f8f43', 'border-radius:10px',
      'padding:6px 8px', 'font:11px/1.35 -apple-system,sans-serif', 'color:#cfead0',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'max-width:44vw', 'text-align:center'
    ].join(';');
    var t = document.createElement('div');
    t.textContent = '收益桥：等待存档…';
    t.style.cssText = 'margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    var b1 = document.createElement('button');
    b1.textContent = '同步到计算器';
    var b2 = document.createElement('button');
    b2.textContent = '复制数据';
    [b1, b2].forEach(function (b) {
      b.style.cssText = 'margin:1px;padding:3px 6px;font:11px -apple-system,sans-serif;' +
        'background:#22402a;color:#d7f4c8;border:1px solid #4f8f43;border-radius:7px';
      box.appendChild(b);
    });
    box.insertBefore(t, b1);
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    b1.addEventListener('click', async function () {
      var url = await pageUrlWithData();
      if (url.length > 60000) { copyText(url); t.textContent = '链接太长，已复制'; return; }
      window.open(url, '_blank');
    });
    b2.addEventListener('click', async function () {
      var st = await stGet(CFG.key, null);
      var payload = { v: 1, at: st && st.at, team: st && st.team, samples: st && st.samples };
      t.textContent = copyText(JSON.stringify(payload)) ? '已复制，去计算器粘贴' : '复制失败';
    });
    document.body.appendChild(box);
    return { set: function (s) { t.textContent = s; } };
  }

  /* ================= 主流程 ================= */
  (async function main() {
    if (isPage()) {
      await injectToPage();
      return;
    }
    if (!/43\.142\.100\.84/.test(location.host)) return;

    var ui = makePill();
    var state = await stGet(CFG.key, null) || { samples: {}, team: null, at: 0 };
    state.samples = state.samples || {};
    var tables;
    try { tables = await loadTables(); }
    catch (e) { ui.set('表数据读取失败'); log(e); }

    async function loop() {
      try {
        state = await tick(state, tables, ui);
        await stSet(CFG.key, state);
      } catch (e) { log(e); ui.set('采样出错，看控制台'); }
      setTimeout(loop, CFG.tickMs);
    }
    ui.set('收益桥：已启动');
    loop();
  })();
})();
