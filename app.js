/* 龙猫放置 · 挂机收益计算器 —— 前端逻辑（无依赖）
 *
 * 公式全部取自游戏客户端 assets/index-*.js，逐条对齐：
 *   防御减伤      Dd(x) = x/(1000+x)                      （Td/Ed）
 *   属性换算      zd() = {hp:vit*6, 物减/魔减:vit*0.8, 防御/魔抗:vit*0.1,
 *                         暴击:luck/30*0.01, 爆伤:luck/30*0.01,
 *                         命中:luck/30*0.003, 攻速:max(力量,魔力)*1e-4}
 *   单次伤害      hv(): 命中=clamp(命中+等级差*0.01-闪避,0,1)
 *                       基础=随机(最小攻,最大攻)*(1+伤害浮动)
 *                       暴击×爆伤 → 减 物减/10 → ×(1-防御减伤) → ×(1+力量*8e-4)
 *                       → ×(1+总伤害加成) → 取整、至少 1
 *   出手间隔      iy() = 1500 / 攻速（攻速 1.18 = 118%）
 *   刷新等待      5000 / 移速
 *   每波只数      spawnMin??1 ~ spawnMax??4（正在打的那波随机，期望取中值）
 *   经验          exp × 经验倍率 × 等级差系数
 *                 等级差系数 Hv(): 差<3 → 1；否则 1 - min(1, floor(差/3)*0.1)
 *   金币          掉落表 gold 行 × (1+金币加成)
 *
 * 未计入：主动技能的伤害与冷却（会影响真实输出，用「伤害系数 k」这个旋钮校准）。
 * 实测数据来自桥接脚本定时读存档的 exp/gold 差值，用来替换模型估值。
 */
(function () {
  'use strict';
  var D = window.LMDATA;
  var LS = 'lm_farm_v1';

  function $(id) { return document.getElementById(id); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(n, d) {
    n = num(n); d = (d === undefined) ? 0 : d;
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return n.toFixed(d).replace(/\.0+$/, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, 1800);
  }

  /* ---------- 角色 ---- */
  function blankChar(i) {
    return {
      name: '角色' + (i + 1), cls: '', clsName: '未填', lv: 50, mag: 0,
      hp: 0, mp: 0, minA: 0, maxA: 0, minMA: 0, maxMA: 0,
      as: 100, cr: 0.05, cd: 1.5, hit: 1, dodge: 0.05,
      def: 0, mres: 0, pRed: 0, mRed: 0,
      ms: 100, goldRate: 0, expMul: 1, dmgBonus: 0,
      str: 0, magi: 0, vit: 0, luck: 0
    };
  }
  function demoTeam() {
    var a = blankChar(0);
    a.name = '示例·Lv50战士'; a.lv = 50; a.clsName = '战士';
    a.hp = 4662; a.mp = 809; a.minA = 320; a.maxA = 460; a.as = 118;
    a.cr = 0.18; a.cd = 1.62; a.hit = 1; a.dodge = 0.08;
    a.def = 460; a.mres = 380; a.pRed = 210; a.mRed = 180; a.ms = 118;
    a.goldRate = 0.1; a.expMul = 1.05; a.str = 180; a.magi = 30; a.vit = 120; a.luck = 45;
    return [a, blankChar(1), blankChar(1), blankChar(1)];
  }

  /* ---------- 状态 ---------- */
  var state = {
    team: [blankChar(0), blankChar(1), blankChar(2), blankChar(3)],
    buffs: [],
    p: { k: 1, msOv: 0 },
    filterMine: true,
    sort: 'mix',
    sel: 0,
    samples: {},
    src: null
  };
  function save() {
    try { localStorage.setItem(LS, JSON.stringify({
      team: state.team, buffs: state.buffs, p: state.p,
      filterMine: state.filterMine, sort: state.sort, samples: state.samples, src: state.src
    })); } catch (e) { }
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(LS) || '');
      if (!s || !s.team) return;
      state.team = s.team.map(function (c, i) { var b = blankChar(i); return Object.assign(b, c); });
      while (state.team.length < 4) state.team.push(blankChar(state.team.length));
      state.buffs = s.buffs || [];
      state.p = Object.assign(state.p, s.p || {});
      state.filterMine = s.filterMine !== false;
      state.sort = s.sort || 'mix';
      state.samples = s.samples || {};
      state.src = s.src || null;
    } catch (e) { }
  }

  /* ---------- 属性 / BUFF ---------- */
  var DIRECT = {
    minAttack: 'minA', maxAttack: 'maxA', minMagicAttack: 'minMA', maxMagicAttack: 'maxMA',
    attackSpeed: 'as', critRate: 'cr', critDamage: 'cd', hitRate: 'hit', dodgeRate: 'dodge',
    defense: 'def', magicResist: 'mres', physicalReduction: 'pRed', magicReduction: 'mRed',
    moveSpeed: 'ms', goldRate: 'goldRate', expMultiplier: 'expMul', hp: 'hp', mp: 'mp',
    damageBonus: 'dmgBonus', hpMax: 'hp', mpMax: 'mp'
  };
  var ATTRS = { strength: 'str', magic: 'magi', vitality: 'vit', luck: 'luck' };

  // 把角色的基础属性 + 选中的 BUFF 折算成有效属性
  function effOf(c) {
    var e = {
      minA: num(c.minA), maxA: num(c.maxA), minMA: num(c.minMA), maxMA: num(c.maxMA),
      as: num(c.as) || 100, cr: num(c.cr), cd: num(c.cd) || 1.5, hit: num(c.hit),
      dodge: num(c.dodge), def: num(c.def), mres: num(c.mres),
      pRed: num(c.pRed), mRed: num(c.mRed), ms: num(c.ms) || 100,
      goldRate: num(c.goldRate), expMul: num(c.expMul) || 1, dmgBonus: num(c.dmgBonus),
      hp: num(c.hp), mp: num(c.mp), magicDmg: !!c.mag, names: []
    };
    state.buffs.forEach(function (bid) {
      var b = null;
      for (var i = 0; i < D.buffs.length; i++) { if (D.buffs[i].id === bid) { b = D.buffs[i]; break; } }
      if (!b) return;
      e.names.push(b.n);
      var v = num(b.v);
      (b.s || []).forEach(function (st) {
        if (ATTRS[st]) {
          var base = num(c[ATTRS[st]]);
          var delta = (b.m === 'percent') ? base * v : v;
          if (st === 'strength' || st === 'magic') {
            e.as += (delta * 1e-4) * 100;        // 攻速 +0.01%/点
            e.strAdd = (e.strAdd || 0) + delta;  // 力量加成在伤害公式里单独乘
          } else if (st === 'vitality') {
            e.hp += delta * 6; e.pRed += delta * 0.8;
            e.mRed += delta * 0.8; e.def += delta * 0.1; e.mres += delta * 0.1;
          } else if (st === 'luck') {
            e.cr += (delta / 30) * 0.01; e.cd += (delta / 30) * 0.01;
            e.hit += (delta / 30) * 0.003;
          }
        } else if (DIRECT[st]) {
          var key = DIRECT[st];
          if (b.m === 'percent') e[key] = (e[key] || 0) * (1 + v);
          else e[key] = (e[key] || 0) + v;
        }
      });
    });
    e.strTotal = num(c.str) + (e.strAdd || 0);
    return e;
  }

  // 对某只怪的每秒有效伤害（已按客户端 hv() 公式，乘上校准系数 k）
  function dpsVs(e, mon, pLv) {
    var k = num(state.p.k) || 1;
    var isMagic = e.magicDmg;
    var mid = isMagic ? (e.minMA + e.maxMA) / 2 : (e.minA + e.maxA) / 2;
    if (mid <= 0) return 0;
    var lvBonus = Math.trunc((num(pLv) - (num(mon.level) || 1)) / 2) * 0.01;
    var hit = Math.max(0, Math.min(1, e.hit + lvBonus - num(mon.dodgeRate)));
    var cr = Math.max(0, Math.min(1, e.cr));
    var crit = 1 + cr * Math.max(0, e.cd - 1);
    var raw = mid * crit;
    raw -= (isMagic ? num(mon.magicReduction) : num(mon.physicalReduction)) / 10;
    if (raw <= 0) raw = 1;
    var dr = (isMagic ? num(mon.magicResist) : num(mon.defense)) / (1000 + (isMagic ? num(mon.magicResist) : num(mon.defense)));
    raw *= (1 - dr);
    raw *= (1 + e.strTotal * 8e-4);
    raw *= (1 + e.dmgBonus + (isMagic ? (e.magDmg || 0) : (e.phyDmg || 0)));
    var val = Math.max(1, Math.round(raw));
    var perSec = (e.as / 100) / 1.5;
    return hit * val * perSec * k;
  }

  function levelDiffFactor(pLv, mLv) {
    var n = num(pLv) - num(mLv);
    if (n < 3) return 1;
    var q = Math.floor(n / 3);
    return Math.max(0, 1 - Math.min(1, q * 0.1));
  }

  function myLevel() {
    var arr = state.team.map(function (c) { return num(c.lv); }).filter(function (v) { return v > 0; });
    if (!arr.length) return 0;
    return Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length);
  }
  function avgOf(field) {
    var list = state.team.filter(function (c) { return num(c.minA) + num(c.minMA) > 0; });
    if (!list.length) return field === 'expMul' ? 1 : 0;
    var s = 0;
    list.forEach(function (c) { s += effOf(c)[field] || 0; });
    return s / list.length;
  }
  function moveSpeed() {
    if (num(state.p.msOv) > 0) return num(state.p.msOv) / 100;
    var ms = avgOf('ms') || 100;
    return Math.max(0.05, ms / 100);
  }

  /* ---------- 地图数据 ---------- */
  var monByArea = {}, drops = D.drops || {};
  D.monsters.forEach(function (m) { (monByArea[m.area] = monByArea[m.area] || []).push(m); });

  function mapMonsters(mapId) {
    var arr = (monByArea[mapId] || []).slice();
    if (!arr.length) return [];
    var wsum = 0;
    arr.forEach(function (m) { wsum += num(m.spawnWeight) || 1; });
    return arr.map(function (m) { return { m: m, w: (num(m.spawnWeight) || 1) / wsum }; });
  }
  function dropInfo(monId) {
    var d = drops[monId];
    if (!d) return { g: 0, val: 0, rare: 0, it: [] };
    var val = 0, rare = 0;
    (d.it || []).forEach(function (r) {
      if (r[3]) { rare += num(r[4]); return; }
      val += num(r[2]) * num(r[4]);
    });
    return { g: num(d.g), val: val, rare: rare, it: d.it || [] };
  }

  function spawnAvg(map) {
    var lo = num(map.smin) || 1, hi = num(map.smax) || 4;
    if (hi < lo) hi = lo;
    return (lo + hi) / 2;
  }

  function calcMap(map) {
    var list = mapMonsters(map.id);
    if (!list.length) return null;
    var pLv = myLevel() || 1;
    var n = spawnAvg(map);
    var exp = 0, gold = 0, dval = 0, rare = 0, killSec = 0, alive = 0;
    list.forEach(function (x) {
      var dps = 0;
      state.team.forEach(function (c) {
        var e = effOf(c);
        var d = dpsVs(e, x.m, pLv);
        if (d > 0) alive++;
        dps += d;
      });
      var hp = num(x.m.hp) || 1;
      killSec += x.w * (dps > 0 ? hp / dps : 1e7);
      exp += x.w * num(x.m.exp) * levelDiffFactor(pLv, x.m.level);
      var dv = dropInfo(x.m.id);
      gold += x.w * dv.g;
      dval += x.w * dv.val;
      rare += x.w * dv.rare;
    });
    if (!alive) return null;
    var ms = moveSpeed();
    var waveSec = killSec * n + 5 / ms;
    var kills = waveSec > 0 ? (3600 / waveSec) * n : 0;
    var expMul = avgOf('expMul') || 1;
    var gr = avgOf('goldRate');
    return {
      exp: kills * exp * expMul,
      gold: kills * gold * (1 + gr),
      drop: kills * dval * (1 + gr),
      rare: kills * rare,
      total: kills * gold * (1 + gr) + kills * dval * (1 + gr),
      sec: waveSec, n: n, list: list, lvUp: expUp(kills * exp * expMul)
    };
  }
  function expUp(expH) {
    var lv = myLevel();
    for (var i = 0; i < D.levels.length; i++) {
      if (D.levels[i].lv === lv) return expH > 0 ? D.levels[i].e / expH : Infinity;
    }
    return Infinity;
  }

  /* ---------- 实测 ---------- */
  function measured(id) {
    var s = state.samples[id];
    if (!s || num(s.sec) < 60) return null;
    var e = (num(s.exp) / num(s.sec)) * 3600;
    var g = (num(s.gold) / num(s.sec)) * 3600;
    return { exp: e, gold: g, sec: num(s.sec), since: s.since };
  }

  /* ---------- 渲染 ---------- */
  function renderTeam() {
    $('team').innerHTML = state.team.map(function (c, i) {
      var e = effOf(c), lv = num(c.lv) || 1;
      var ref = { defense: 0, magicResist: 0, physicalReduction: 0, magicReduction: 0, dodgeRate: 0, level: lv };
      var d = dpsVs(e, ref, lv);
      var on = state.sel === i;
      return '<button class="tcard' + (on ? ' on' : '') + '" data-i="' + i + '">' +
        '<div class="nm">' + esc(c.name || '角色') + '</div>' +
        '<div class="cl">' + (c.clsName || '') + ' Lv' + (c.lv || 0) + '</div>' +
        '<div class="dps">' + (d > 0 ? fmt(d, 0) + '/s' : '未填') + '</div></button>';
    }).join('');
    renderEditor();
  }

  var FIELDS = [
    ['name', '名字', 'text'], ['lv', '等级', 'num'],
    ['hp', '生命', 'num'], ['mp', '魔法', 'num'],
    ['minA', '最小攻', 'num'], ['maxA', '最大攻', 'num'],
    ['as', '攻速%', 'num'], ['cr', '暴击率', 'num'], ['cd', '爆伤', 'num'],
    ['hit', '命中率', 'num'], ['dodge', '闪避', 'num'],
    ['def', '防御', 'num'], ['mres', '魔抗', 'num'],
    ['pRed', '物减', 'num'], ['mRed', '魔减', 'num'], ['ms', '移速%', 'num'],
    ['goldRate', '金币加成', 'num'], ['expMul', '经验倍率', 'num'], ['dmgBonus', '总伤害加成', 'num'],
    ['str', '力量', 'num'], ['magi', '魔力', 'num'], ['vit', '体力', 'num'], ['luck', '幸运', 'num']
  ];
  function renderEditor() {
    var box = $('editor');
    if (state.sel < 0) {
      box.innerHTML = '<div class="note">点上方角色卡片填属性；手动不确定就先「载入示例队伍」看效果，装好桥接脚本可自动填真实数值。</div>';
      return;
    }
    var c = state.team[state.sel], e = effOf(c);
    var head = '<div class="row" style="margin-bottom:8px">' +
      '<span class="chip">' + esc(c.name) + '</span>' +
      '<span class="chip">攻速 ' + fmt(e.as, 1) + '%</span>' +
      '<span class="chip">暴击 ' + (e.cr * 100).toFixed(1) + '% × ' + fmt(e.cd, 2) + '</span>' +
      '<span class="chip">命中 ' + (e.hit * 100).toFixed(0) + '%</span>' +
      '</div>';
    var html = head + '<div class="grid3">';
    FIELDS.forEach(function (f) {
      var key = f[0];
      html += '<div class="f"><label>' + f[1] + '</label><input data-k="' + key + '" type="' +
        (f[2] === 'num' ? 'number' : 'text') + '"' + (f[2] === 'num' ? ' inputmode="decimal" step="any"' : '') +
        ' value="' + esc(c[key]) + '"></div>';
    });
    box.innerHTML = html + '</div>';
  }

  function renderSlots() {
    var html = '';
    for (var i = 0; i < 2; i++) {
      var b = null;
      for (var j = 0; j < D.buffs.length; j++) { if (D.buffs[j].id === state.buffs[i]) { b = D.buffs[j]; break; } }
      html += '<div class="slot' + (b ? ' has' : '') + '">' +
        (b ? '<div class="sn">' + esc(b.n) + '</div><div class="sd">' + esc(b.d || '') + '</div>'
          : '<div class="sd">空槽位（最多 2 个，第 3 个顶掉最早的）</div>') + '</div>';
    }
    $('slots').innerHTML = html;
  }
  function renderBuffList(force) {
    var box = $('bufflist');
    if (!force && box.style.display === 'none') { box.style.display = 'block'; return; }
    box.style.display = 'block';
    var groups = {};
    D.buffs.forEach(function (b) { (groups[b.g] = groups[b.g] || []).push(b); });
    var html = '';
    Object.keys(groups).forEach(function (g) {
      html += '<div class="bgroup">' + esc(g) + '（' + groups[g].length + '）</div>';
      groups[g].forEach(function (b) {
        var on = state.buffs.indexOf(b.id) >= 0;
        html += '<button class="bitem' + (on ? ' on' : '') + '" data-buff="' + esc(b.id) + '">' +
          '<span><b>' + esc(b.n) + '</b><br><span class="bd">' + esc(b.d || '') + '</span></span>' +
          '<span class="bd">' + Math.round(num(b.t) / 60) + '分</span></button>';
      });
    });
    box.innerHTML = html;
  }

  function visibleMaps() {
    var lv = myLevel();
    return D.maps.filter(function (m) {
      if (!mapMonsters(m.id).length) return false;
      if (!state.filterMine || !lv) return true;
      var lo = num(m.lmin), hi = num(m.lmax) || lo + 12;
      return lv >= lo - 3 && lv <= hi + 6;
    });
  }

  function renderMaps() {
    var rows = [], lv = myLevel();
    visibleMaps().forEach(function (m) {
      var c = calcMap(m);
      if (!c) return;
      rows.push({ m: m, c: c, ms: measured(m.id) });
    });
    var maxExp = 0, maxGold = 0;
    rows.forEach(function (r) {
      var e = r.ms ? r.ms.exp : r.c.exp;
      var g = r.ms ? (r.ms.gold + r.c.drop) : r.c.total;
      if (e > maxExp) maxExp = e;
      if (g > maxGold) maxGold = g;
    });
    rows.sort(function (a, b) {
      function val(r) {
        var e = r.ms ? r.ms.exp : r.c.exp;
        var g = r.ms ? (r.ms.gold + r.c.drop) : r.c.total;
        if (state.sort === 'exp') return e / (maxExp || 1);
        if (state.sort === 'gold') return g / (maxGold || 1);
        return e / (maxExp || 1) + g / (maxGold || 1);
      }
      return val(b) - val(a);
    });
    $('mapHint').textContent = rows.length + ' 张图 · Lv' + (lv || '?');
    $('maps').innerHTML = rows.length ? rows.map(function (x, idx) {
      var v = x.ms ? { exp: x.ms.exp, gold: x.ms.gold, total: x.ms.gold + x.c.drop } : x.c;
      var tag = x.ms ? '<span class="chip m">实测</span>' : '<span class="chip e">估</span>';
      var lvTxt = (x.m.lmin || '?') + '~' + (x.m.lmax || '?');
      var dropsHtml = '';
      x.c.list.forEach(function (y) {
        var dv = dropInfo(y.m.id);
        if (!dv.it.length) return;
        dropsHtml += '<tr><td colspan="4" style="color:#cfe3cc">' + esc(y.m.name) + '</td></tr>';
        dv.it.slice(0, 5).forEach(function (r) {
          dropsHtml += '<tr><td>' + esc(r[1]) + '</td><td>' + num(r[2]).toFixed(0) + '</td><td>' +
            fmt(r[4], 3) + '</td><td>' + (r[3] ? '稀有' : fmt(num(r[2]) * num(r[4]), 1)) + '</td></tr>';
        });
      });
      return '<div class="mcard" data-idx="' + idx + '">' +
        '<div class="mhead"><span class="mn">' + esc(x.m.n) + '</span>' + tag +
        '<span class="lv">Lv' + lvTxt + '</span></div>' +
        '<div class="mbody">' +
        '<div class="kv"><div class="k">经验/h</div><div class="v exp">' + fmt(v.exp) + '</div></div>' +
        '<div class="kv"><div class="k">直掉金币/h</div><div class="v gold">' + fmt(v.gold) + '</div></div>' +
        '<div class="kv"><div class="k">含掉落合计/h</div><div class="v">' + fmt(v.total) + '</div></div>' +
        '</div>' +
        '<div class="detail" id="dt' + idx + '">' +
        '<div>怪物：' + esc(x.c.list.map(function (y) { return y.m.name; }).slice(0, 6).join('、')) + '</div>' +
        '<div>每波 ' + fmt(x.c.n, 1) + ' 只 · 每波约 ' + x.c.sec.toFixed(1) + ' 秒 · ' +
        (isFinite(x.c.lvUp) ? '升一级约 ' + x.c.lvUp.toFixed(1) + ' 小时' : '经验为 0（等级差惩罚）') + '</div>' +
        (x.c.rare > 0 ? '<div>稀有掉落约 ' + fmt(x.c.rare, 2) + ' 件/h（不计金）</div>' : '') +
        '<table class="tbl"><thead><tr><th>掉落</th><th>卖价</th><th>期望/h</th><th>价值/h</th></tr></thead><tbody>' +
        dropsHtml + '</tbody></table></div></div>';
    }).join('') : '<div class="note">没有匹配的图，关掉「只看我的等级段」看看。</div>';
  }

  function renderCalib() {
    $('pK').value = state.p.k;
    $('pMo').value = state.p.msOv;
    var ids = Object.keys(state.samples).filter(function (k) { return num(state.samples[k].sec) >= 60; });
    var txt;
    if (!ids.length) {
      txt = '还没有实测数据。表格里全部是 <span class="chip e">估</span>，挂过图并同步后会自动变 <span class="chip m">实测</span>。';
    } else {
      txt = '已实测 ' + ids.length + ' 张图：' + ids.map(function (id) {
        var m = null;
        for (var i = 0; i < D.maps.length; i++) { if (D.maps[i].id === id) { m = D.maps[i]; break; } }
        return (m ? m.n : id) + ' ' + Math.round(num(state.samples[id].sec) / 60) + '分';
      }).join('、');
    }
    $('calibNote').innerHTML = txt;
  }

  function renderAll() { renderTeam(); renderSlots(); renderMaps(); renderCalib(); save(); }

  /* ---------- 事件 ---------- */
  $('team').addEventListener('click', function (e) {
    var b = e.target.closest('.tcard');
    if (!b) return;
    state.sel = num(b.getAttribute('data-i'));
    renderTeam();
  });
  $('editor').addEventListener('input', function (e) {
    var inp = e.target, key = inp.getAttribute('data-k');
    if (!key || state.sel < 0) return;
    state.team[state.sel][key] = (inp.type === 'number')
      ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value;
    renderTeamSilent(); renderMaps(); renderCalib(); save();
  });
  function renderTeamSilent() {
    // 不重绘编辑器（避免输入时丢焦点），只更新卡片摘要
    var c = state.team[state.sel], card = document.querySelector('.tcard[data-i="' + state.sel + '"]');
    if (!card) return;
    var e = effOf(c), lv = num(c.lv) || 1;
    var d = dpsVs(e, { defense: 0, magicResist: 0, physicalReduction: 0, magicReduction: 0, dodgeRate: 0, level: lv }, lv);
    card.querySelector('.nm').textContent = c.name || '角色';
    card.querySelector('.cl').textContent = (c.clsName || '') + ' Lv' + (c.lv || 0);
    card.querySelector('.dps').textContent = d > 0 ? fmt(d, 0) + '/s' : '未填';
  }

  $('btnDemo').addEventListener('click', function () {
    state.team = demoTeam(); state.sel = 0; renderAll(); toast('已载入示例队伍');
  });
  $('btnClear').addEventListener('click', function () {
    state.team = [blankChar(0), blankChar(1), blankChar(2), blankChar(3)];
    state.sel = 0; renderAll(); toast('已清空');
  });
  function exportJson() {
    return JSON.stringify({
      v: 1, at: Date.now(), team: state.team, buffs: state.buffs,
      p: state.p, samples: state.samples
    });
  }
  $('btnCsv').addEventListener('click', function () {
    $('impBox').open = true;
    $('impTa').value = exportJson();
    $('impTa').select();
  });
  $('btnExp').addEventListener('click', function () {
    $('impTa').value = exportJson(); $('impTa').select(); toast('已填入文本框');
  });
  $('btnImp').addEventListener('click', function () { importJson($('impTa').value); });
  $('btnPickBuff').addEventListener('click', function () { renderBuffList(true); });
  $('btnClearBuff').addEventListener('click', function () {
    state.buffs = []; renderAll();
  });
  $('bufflist').addEventListener('click', function (e) {
    var b = e.target.closest('[data-buff]');
    if (b) toggleBuff(b.getAttribute('data-buff'));
  });
  function toggleBuff(id) {
    var i = state.buffs.indexOf(id);
    if (i >= 0) state.buffs.splice(i, 1);
    else {
      var g = '食物';
      for (var j = 0; j < D.buffs.length; j++) { if (D.buffs[j].id === id) { g = D.buffs[j].g; break; } }
      if (state.buffs.length >= 2) state.buffs.shift();
      state.buffs = state.buffs.filter(function (x) {
        for (var k = 0; k < D.buffs.length; k++) {
          if (D.buffs[k].id === x) return D.buffs[k].g !== g;
        }
        return true;
      });
      state.buffs.push(id);
    }
    renderSlots(); renderBuffList(true); renderTeam(); renderMaps(); renderCalib(); save();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('on'); });
      t.classList.add('on');
      state.sort = t.getAttribute('data-sort');
      renderMaps(); save();
    });
  });
  $('btnFilter').addEventListener('click', function () {
    state.filterMine = !state.filterMine;
    $('btnFilter').classList.toggle('primary', state.filterMine);
    renderMaps(); save();
  });
  $('maps').addEventListener('click', function (e) {
    var card = e.target.closest('.mcard');
    if (!card) return;
    var dt = document.getElementById('dt' + card.getAttribute('data-idx'));
    if (dt) { dt.classList.toggle('on'); card.classList.toggle('open'); }
  });
  $('pK').addEventListener('input', function () {
    var v = num(this.value); if (v > 0) { state.p.k = v; renderTeam(); renderMaps(); renderCalib(); save(); }
  });
  $('pMo').addEventListener('input', function () {
    var v = num(this.value); state.p.msOv = v > 0 ? v : 0;
    renderMaps(); renderCalib(); save();
  });

  /* ---------- 导入 ---------- */
  function importJson(txt) {
    var o;
    try { o = JSON.parse(String(txt || '').trim()); }
    catch (err) { toast('这段数据解析不了'); return; }
    if (o.team && o.team.length) {
      state.team = o.team.slice(0, 4).map(function (c, i) { var b = blankChar(i); return Object.assign(b, c); });
      while (state.team.length < 4) state.team.push(blankChar(state.team.length));
    }
    if (o.buffs) state.buffs = o.buffs.slice(0, 2);
    if (o.p) state.p = Object.assign(state.p, o.p);
    if (o.samples) {
      Object.keys(o.samples).forEach(function (k) {
        if (!state.samples[k] || num(o.samples[k].sec) > num(state.samples[k].sec)) state.samples[k] = o.samples[k];
      });
    }
    state.sel = 0;
    renderAll(); toast('导入成功');
    $('impBox').open = false;
  }

  /* ---------- 桥接注入 ---------- */
  function absorb(obj) {
    if (!obj) return;
    if (obj.team && obj.team.length) {
      var when = obj.at ? new Date(obj.at).toLocaleString('zh-CN') : '';
      $('srcCard').style.display = 'block';
      $('srcHint').textContent = when ? ('游戏数据 · ' + when) : '游戏数据';
      $('btnApplyBridge').onclick = function () {
        importJson(JSON.stringify(obj));
        $('srcCard').style.display = 'none';
      };
      $('btnDropBridge').onclick = function () { $('srcCard').style.display = 'none'; };
    }
    if (obj.samples) {
      var changed = false;
      Object.keys(obj.samples).forEach(function (k) {
        if (!state.samples[k] || num(obj.samples[k].sec) > num(state.samples[k].sec)) {
          state.samples[k] = obj.samples[k]; changed = true;
        }
      });
      if (changed) { renderMaps(); renderCalib(); save(); }
    }
  }

  /* ---------- 启动 ---------- */
  load();
  $('meta').textContent = 'v' + (D.meta.ver || '') + ' · 数据 ' + String(D.meta.builtAt || '').slice(5, 10) +
    ' · ' + D.maps.length + '图/' + D.monsters.length + '怪/' + D.buffs.length + 'BUFF';
  $('btnFilter').classList.toggle('primary', state.filterMine);
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.classList.toggle('on', t.getAttribute('data-sort') === state.sort);
  });
  renderAll();

  if (window.__LM_STATE) absorb(window.__LM_STATE);
  try {
    var h = location.hash || '';
    var mm = h.match(/#d=([^&]+)/);
    if (mm) absorb(JSON.parse(decodeURIComponent(mm[1])));
  } catch (e) { }
  window.__lmAbsorb = absorb;
})();
