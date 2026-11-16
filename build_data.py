# -*- coding: utf-8 -*-
"""把游戏静态表压成页面用的 data.js。

掉落按客户端 Nv() 的真实语义聚合：
  · independent   : 逐条独立判定，期望 = chance × (min+max)/2
  · group_pick_1  : 整个池的概率 = 池内 seq 最小那条的 chance；
                    命中后池内【等概率】选一条，数量 = 那条的 min~max
来源：assets/index-*.js 内 function Nv(e,{rng})
"""
import json, io, collections, time, os

SRC = r"C:\Temp\g4data"
OUT = r"E:\Software Development\Software Development\longmao-farm-calculator\data.js"


def load(n):
    return json.load(io.open(os.path.join(SRC, n + ".json"), encoding="utf-8"))


items = {it["id"]: it for it in load("items")}
mons = load("monsters")
maps = load("maps")
regs = load("regions")
drops = load("drops")
levels = load("level_exp")
classes = load("classes")
sets = load("set_bonus")

by_group = collections.defaultdict(list)
for d in drops:
    by_group[d["groupId"]].append(d)
for g in by_group.values():
    g.sort(key=lambda x: x["seq"])

MONKEEP = ("id", "name", "area", "level", "hp", "mp", "exp", "spawnWeight",
           "attack", "minAttack", "maxAttack", "magicAttack", "minMagicAttack", "maxMagicAttack",
           "physicalReduction", "magicReduction", "defense", "magicResist",
           "hitRate", "dodgeRate", "critRate", "critDamage", "attackSpeed",
           "damageVariance", "attackTargets", "isBoss", "damageCategory", "skillId")

drop_exp = {}
for m in mons:
    gid = m.get("dropGroupId") or ("g_" + m["id"])
    rows = by_group.get(gid, [])
    gold_p = 0.0
    gold_avg = 0.0
    exp_map = collections.defaultdict(float)
    pools = collections.OrderedDict()
    for r in rows:
        p = float(r.get("chance") or 0)
        qty = (float(r.get("min") or 1) + float(r.get("max") or 1)) / 2.0
        if r["rollMode"] == "independent":
            if r["itemId"] == "gold":
                gold_p += p
                gold_avg += p * qty
            else:
                exp_map[r["itemId"]] += p * qty
        else:
            pools.setdefault(r.get("pool") or "?", []).append((r["itemId"], p, qty))
    for pool, arr in pools.items():
        p_pool = arr[0][1]                       # 第一条的 chance 即整池概率
        per = p_pool / len(arr)                  # 池内等概率
        for item_id, _p, qty in arr:
            exp_map[item_id] += per * qty

    entries = []
    for item_id, q in exp_map.items():
        if q < 0.002:
            continue
        it = items.get(item_id)
        if not it:
            continue
        entries.append((item_id, it.get("name", item_id), float(it.get("sellPrice") or 0),
                        1 if it.get("rare") else 0, round(q, 5)))
    entries.sort(key=lambda x: -(x[2] * x[4]))
    entries = entries[:18]
    drop_exp[m["id"]] = {
        "gp": round(gold_p, 4),
        "g": round(gold_avg, 3),
        "it": [[e[0], e[1], e[2], e[3], e[4]] for e in entries],
    }


def buff_group(name):
    if "圣水" in name:
        return "圣水"
    if "爆发药" in name:
        return "爆发药"
    if "免疫" in name:
        return "免疫药剂"
    if "吸收" in name:
        return "伤害吸收"
    return "食物"


buffs = []
for it in items.values():
    if it.get("potionType") != "buff":
        continue
    eff = it.get("effects")
    if isinstance(eff, dict):
        eff = [eff]
    if not isinstance(eff, list) or not eff:
        continue
    e = eff[0]
    buffs.append({
        "id": it["id"], "n": it.get("name"), "d": it.get("description") or "",
        "t": int(e.get("duration") or 0),
        "s": e.get("stats") or [], "m": e.get("mode") or "flat",
        "v": e.get("value") or 0,
        "g": buff_group(it.get("name") or ""),
    })

data = {
    "meta": {
        "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "src": "http://43.142.100.84:8080/data/*.json?v=1794598906629",
        "ver": "0.2",
        "dropsNote": "independent 逐条独立；group_pick_1 池概率=首行 chance、池内等概率、数量取该行 min~max",
    },
    "regions": [{"id": r["id"], "n": r["name"], "k": r.get("kind")} for r in regs],
    "maps": [{"id": m["id"], "n": m["name"], "r": m["regionId"], "o": m.get("order"),
              "lmin": m.get("levelMin"), "lmax": m.get("levelMax"),
              "smin": m.get("spawnMin"), "smax": m.get("spawnMax"),
              "d": m.get("desc")} for m in maps],
    "monsters": [{k: m.get(k) for k in MONKEEP if m.get(k) is not None} for m in mons],
    "drops": drop_exp,
    "buffs": buffs,
    "levels": [{"lv": x["level"], "e": x["expToNext"]} for x in levels],
    "classes": [{"id": c["id"], "n": c["name"], "b": c["base"], "w": c.get("growth")} for c in classes],
    "sets": [{"id": s["id"], "n": s["name"], "t": s["tiers"]} for s in sets],
}

js = "window.LMDATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
io.open(OUT, "w", encoding="utf-8", newline="\n").write(js)
print("maps", len(data["maps"]), "monsters", len(data["monsters"]),
      "buffs", len(data["buffs"]), "dropsGroups", len(drop_exp))
print("bytes", os.path.getsize(OUT))
