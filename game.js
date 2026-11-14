/* ============================================================================
 *  随机碰撞竞技场 —— 双角色自动对战框架（Auto-Battler Arena Framework）
 *  ---------------------------------------------------------------------------
 *  分层：
 *    0. 工具函数        随机数 / 数学
 *    1. 配置 CFG        画布、擂台、模拟步长
 *    2. 实体 Entity     Fighter / Rock / StockGem / Whip / Slide / 表现层特效
 *    3. 技能表 SKILLS   「技能」= 冷却 + 条件 + 效果原语（数据驱动，可插拔）
 *    4. 角色表 CHARS    一个角色 = 一组属性 + 一组技能 key
 *    5. 世界 World      固定步长推进 + 碰撞 + 结算 + 渲染
 *    6. 流程 / UI       开局、加速、结算、重开
 *
 *  加一个新角色只需要：写个 drawXXX() + 在 CHARS 里加一条配置。
 *  加一个新技能只需要：在 SKILLS 里加一条，然后挂到角色的 skills 数组里。
 * ==========================================================================*/
(() => {
  'use strict';

  // ======================= 0. 工具 =======================
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // 可复现随机数：同一个种子 → 同一场战斗（方便回放/复盘/联机）
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ======================= 资源 =======================
  // 换贴图只要改这里（换成同样透明背景的 PNG，路径/文件名也可以直接替换）
  const ART = {
    gatling: {
      file: 'assets/gatling-pea.png',  // 角色贴图
      height: 176,                     // 画多高（像素，画布 1080 基准）
      feetY: 82,                       // 脚底对齐到角色中心的哪个 y（越大越靠下）
    },
    pea: {
      file: 'assets/pea.png',          // 子弹贴图
      scale: 1.0,                      // 子弹出图大小倍率
    },
    jiaoge: {
      file: 'assets/jiaoge.png',       // 叫哥（原图朝左，绘制时会镜像）
      height: 196,
      feetY: 86,
    },
    tuberr: {
      file: 'assets/tuberr.png',       // tuberr（钻石脸，会随转速旋转）
      height: 200,
      feetY: 88,
    },
    muzzle: { x: 52, y: -22 },         // 炮口位置（朝右时相对角色中心），改这里对准新贴图的炮口
  };

  const IMG = {};

  function spriteReady(key) {
    const im = IMG[key];
    return !!(im && im.complete && im.naturalWidth > 0);
  }

  let spriteLoadWarned = false;
  function loadSprite(key, src) {
    // 单文件版会把图片以 data URI 塞进 window.__ASSETS，这里做一次映射
    const realSrc = (window.__ASSETS && window.__ASSETS[src]) || src;
    const im = new Image();
    IMG[key] = im;
    im.addEventListener('load', onSpriteLoaded);
    im.addEventListener('error', function () {
      if (!spriteLoadWarned) {
        spriteLoadWarned = true;
        console.warn('[竞技场] 贴图加载失败：' + src + '。请确认 assets/ 目录与 index.html 同级。当前用占位图形代替。');
      }
    });
    im.src = realSrc;
    // 缓存命中时 load 事件可能早于监听，用 decode() 再兜一层
    if (im.decode) {
      im.decode().then(onSpriteLoaded).catch(function () {});
    } else if (im.complete && im.naturalWidth) {
      setTimeout(onSpriteLoaded, 0);
    }
    return im;
  }

  // 贴图是异步的：任何一张加载/解码完成，就把所有头像重画一遍（多兜几次防时序问题）
  function onSpriteLoaded() {
    refreshPortraits();
    setTimeout(refreshPortraits, 60);
    setTimeout(refreshPortraits, 400);
    setTimeout(refreshPortraits, 1200);
  }

  loadSprite('gatling', ART.gatling.file);
  loadSprite('pea', ART.pea.file);
  loadSprite('jiaoge', ART.jiaoge.file);
  loadSprite('tuberr', ART.tuberr.file);


  // ======================= 1. 配置 =======================
  const CFG = {
    W: 1080, H: 1080,
    arena: { x: 70, y: 300, w: 940, h: 690 },   // 擂台（遇墙反弹的边界）
    step: 1 / 60,                               // 固定模拟步长
    maxSteps: 6,                                // 单帧最多补几步，防卡死
    fighterR: 46,                               // 角色碰撞半径
    speed: { min: 130, max: 300 },              // 角色速度区间
    jitter: [0.10, 0.32],                       // 撞墙后随机偏转角(rad)
    startHp: 1200,
    dmgMul: 1.6,                                // 全局伤害倍率（所有角色一起加强）
  };

  const COLOR = {
    bg1: '#25abe0', bg2: '#1287ba',
    frame: '#0f2b3a',
    red: '#e5453f', green: '#1f9d55', gold: '#f2c14e',
    purple: '#8a5cd6', ink: '#0f2b3a',
  };

  // ======================= 2. 实体 =======================
  let uid = 1;

  class Entity {
    constructor() {
      this.id = uid++;
      this.x = 0; this.y = 0;
      this.r = 16;
      this.dead = false;
      this.age = 0;
    }
    update() {}
    draw() {}
  }

  /* ---------- 角色 ---------- */
  class Fighter extends Entity {
    constructor(world, charKey, x, y, team) {
      super();
      const def = CHARS[charKey];
      this.world = world;
      this.key = charKey;
      this.def = def;
      this.name = def.name;
      this.team = team;
      this.r = CFG.fighterR;

      this.x = x; this.y = y;
      this.spdMin = CFG.speed.min + (def.speedBonus || 0);
      this.spdMax = CFG.speed.max + (def.speedBonus || 0);
      const ang = world.rand(0, TAU);
      this.speed = world.rand(this.spdMin, this.spdMax);
      this.vx = Math.cos(ang) * this.speed;
      this.vy = Math.sin(ang) * this.speed;
      this.face = this.vx >= 0 ? 1 : -1;

      this.maxHp = CFG.startHp + (def.hpBonus || 0);
      this.hp = this.maxHp;
      this.hitFlash = 0;
      this.shield = 0;

      // 每个技能实例：数据来自 SKILLS，冷却状态挂在角色身上
      this.skills = def.skills.map((k) => ({
        key: k,
        def: SKILLS[k],
        cd: Math.random() * 0.8,   // 开局错开一点，避免同时放
      }));

      // 弹药型技能的公共资源池（例如「石块 9/20」）
      this.ammo = { cur: 20, max: 20, regen: 1.2 };  // 每秒回复

      // 冲刺/位移状态
      this.dash = null;

      // AI 施法节流
      this.thinkTimer = world.rand(0.3, 1.0);

      // 被击退：短时间保持高速度，结束后恢复正常速度
      this.knock = 0;
      this.stun = 0;          // 眩晕剩余时间（撞墙触发）
      this.deflectCd = 0;     // 自动弹反的短冷却
      this.autoDeflect = this.skills.some(function (s) { return s.key === 'racket'; });

      // 旋转体（tuberr）：转速越高伤害越高，撞人后掉速
      this.spinner = !!def.spinner;
      this.spin = this.spinner ? 6 : 0;
      this.spinAngle = Math.random() * TAU;
      this.spinMin = 5;
      this.spinMax = 26;
      this.spinGrow = 1.15;     // 每秒涨多少转速
      this.spinHitCd = 0;
      this.invuln = 0;          // 无敌剩余时间

      // 大招（机枪豌豆专用）：剩余时间 / 开火累加器 / 开火间隔
      this.ult = 0;
      this.ultAcc = 0;
      this.ultTick = 0.06;

      // 普通攻击的四连发：剩余发数 / 累加器 / 发间隔
      this.burst = 0;
      this.burstAcc = 0;
      this.burstTick = 0.09;
    }

    get alive() { return this.hp > 0; }

    update(dt) {
      const w = this.world;
      this.age += dt;
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3);
      this.ammo.cur = Math.min(this.ammo.max, this.ammo.cur + this.ammo.regen * dt);

      // —— 旋转体：转速随时间上升，接触造成伤害 ——
      if (this.invuln > 0) this.invuln -= dt;
      if (this.spinner) {
        this.spin = Math.min(this.spinMax, this.spin + this.spinGrow * dt);
        this.spinAngle += this.spin * dt;
        this.spinHitCd = Math.max(0, this.spinHitCd - dt);
        const tgt = w.enemyOf(this);
        if (tgt && tgt.alive && this.spinHitCd <= 0 && dist(this, tgt) < this.r + tgt.r + 10) {
          // 转速 5 → 30 伤害，转速 26 → 164（上限比原来翻倍）
          const dmg = Math.round(30 + (this.spin - this.spinMin) * 6.4);
          tgt.takeDamage(dmg, 'attack');
          const dd = dist(this, tgt) || 1;
          tgt.knockback((tgt.x - this.x) / dd, (tgt.y - this.y) / dd, 380);
          w.shake = Math.min(16, w.shake + 5);
          // 冲刺无敌期间撞人不掉速，正常旋转撞人才掉速
          if (this.invuln <= 0) this.spin = Math.max(this.spinMin, this.spin * 0.45);
          this.spinHitCd = 0.3;
        }
      }

      // —— 眩晕：不能移动、不能放技能 ——
      if (this.stun > 0) {
        this.stun -= dt;
        this.vx *= 0.86;
        this.vy *= 0.86;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.bounceWalls(w);
        for (const s of this.skills) s.cd = Math.max(0, s.cd - dt);
        if (this.stun <= 0) {
          this.speed = w.rand(this.spdMin, this.spdMax);
          const sa = w.rand(0, TAU);
          this.vx = Math.cos(sa) * this.speed;
          this.vy = Math.sin(sa) * this.speed;
        }
        return;
      }
      // —— 大招：2 秒内朝前方 30° 扇形疯狂扫射 ——
      if (this.ult > 0) {
        this.ult -= dt;
        this.ultAcc += dt;
        const target = w.enemyOf(this);
        while (this.ultAcc >= this.ultTick) {
          this.ultAcc -= this.ultTick;
          if (target && target.alive) {
            for (let i = 0; i < 2; i++) firePea(this, target, w, { spread: 15, dmg: 9, speed: 720, r: 10 });
          }
        }
        if (this.ult <= 0) { this.ult = 0; this.ultAcc = 0; }
      } else if (this.burst > 0) {
        // —— 普通攻击：四发子弹依次射出（不是扇形） ——
        this.burstAcc += dt;
        while (this.burst > 0 && this.burstAcc >= this.burstTick) {
          this.burstAcc -= this.burstTick;
          this.burst--;
          const foe2 = w.enemyOf(this);
          if (foe2 && foe2.alive) {
            this.face = foe2.x >= this.x ? 1 : -1;
            firePea(this, foe2, w, { spread: 2.5, dmg: 14, speed: 680 });
            if (w.rand(0, 1) < 0.03) { startPeaUlt(this, w); break; }
          }
        }
        if (this.burst <= 0) { this.burst = 0; this.burstAcc = 0; }
      }

      // --- 位移：匀速直线 + 遇墙反弹 + 随机偏转 ---
      if (this.dash) {
        this.dash.t -= dt;
        if (this.dash.t <= 0) {
          this.dash = null;
          // 冲刺结束 → 恢复常规速度，方向随机抖一下
          this.speed = w.rand(this.spdMin, this.spdMax);
          const a = Math.atan2(this.vy, this.vx) + w.rand(-0.4, 0.4);
          this.vx = Math.cos(a) * this.speed;
          this.vy = Math.sin(a) * this.speed;
        }
      }

      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.bounceWalls(w);
      if (this.knock > 0) {
        this.knock -= dt;
        if (this.knock <= 0) {
          this.speed = w.rand(this.spdMin, this.spdMax);
          const ka = Math.atan2(this.vy, this.vx);
          this.vx = Math.cos(ka) * this.speed;
          this.vy = Math.sin(ka) * this.speed;
        }
      }
      if (Math.abs(this.vx) > 8) this.face = this.vx > 0 ? 1 : -1;

      // --- 技能冷却 & AI 决策 ---
      for (const s of this.skills) s.cd = Math.max(0, s.cd - dt);

      this.thinkTimer -= dt;
      if (this.thinkTimer <= 0) {
        this.thinkTimer = w.rand(0.25, 0.6);
        this.think();
      }

      // 自动弹反：正前方有子弹飞来就立刻挥拍，不等 AI 决策
      if (this.deflectCd > 0) this.deflectCd -= dt;
      if (this.autoDeflect && this.deflectCd <= 0) {
        const b = this.findIncomingBullet(w);
        if (b) {
          this.deflectCd = 0.4;
          racketSwing(this, w, Math.atan2(b.y - this.y, b.x - this.x));
        }
      }
    }

    // 找一颗正朝我飞来的敌方子弹
    findIncomingBullet(w) {
      let best = null, bestD = 1e9;
      for (const e of w.entities) {
        if (e === this || e.owner === this) continue;
        if (typeof e.dmg !== 'number' || typeof e.vx !== 'number') continue;
        const d = dist(e, this);
        if (d > 400 || d < 24) continue;
        const toMe = Math.atan2(this.y - e.y, this.x - e.x);
        const move = Math.atan2(e.vy, e.vx);
        if (Math.abs(normAngle(toMe - move)) > 0.7) continue;   // 不是冲我来的
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    }

    bounceWalls(w) {
      const a = CFG.arena;
      let hx = 0, hy = 0;
      if (this.x - this.r < a.x) { this.x = a.x + this.r; hx = 1; }
      if (this.x + this.r > a.x + a.w) { this.x = a.x + a.w - this.r; hx = -1; }
      if (this.y - this.r < a.y) { this.y = a.y + this.r; hy = 1; }
      if (this.y + this.r > a.y + a.h) { this.y = a.y + a.h - this.r; hy = -1; }
      if (!hx && !hy) return;

      // 被击退时撞墙 → 眩晕
      if (this.knock > 0) {
        this.knock = 0;
        this.stun = 1.0;
        w.popText(this.x, this.y - 154, '眩晕!', '#ffe066', 32);
        w.burst(this.x, this.y, '#ffe066', 18);
        w.shake = Math.min(18, w.shake + 9);
      }

      // 先随机偏转，再把法向速度强制指向场内 → 保证「弹得开、不会卡墙角」
      this.randomDeflect(w, 1);
      if (hx === 1) this.vx = Math.abs(this.vx);
      if (hx === -1) this.vx = -Math.abs(this.vx);
      if (hy === 1) this.vy = Math.abs(this.vy);
      if (hy === -1) this.vy = -Math.abs(this.vy);
    }

    // 撞墙/互撞后的“随机碰撞”：改方向 + 改速度
    randomDeflect(w, power) {
      const a = Math.atan2(this.vy, this.vx) + w.rand(-1, 1) * w.rand(CFG.jitter[0], CFG.jitter[1]) * power;
      this.speed = clamp(this.speed * w.rand(0.88, 1.12), this.spdMin, this.spdMax);
      this.vx = Math.cos(a) * this.speed;
      this.vy = Math.sin(a) * this.speed;
    }

    // --- AI：技能自带的 canCast 判断条件，这里只负责“想不想放” ---
    think() {
      const w = this.world;
      const foe = w.enemyOf(this);
      if (!foe || !foe.alive) return;
      if (this.ult > 0) return;   // 大招期间专注扫射

      for (const s of this.skills) {
        if (s.cd > 0) continue;
        const ok = s.def.canCast ? s.def.canCast(this, foe, w) : true;
        if (!ok) continue;
        // 距离越近越容易放，制造一点“犹豫感”
        const d = dist(this, foe);
        const urge = s.def.urge ? s.def.urge(this, foe, w) : 0.6;
        if (w.rand(0, 1) > urge) continue;
        this.cast(s, foe);
        break; // 一次只放一个技能
      }
    }

    cast(slot, foe) {
      const w = this.world;
      slot.cd = slot.def.cd;
      slot.def.cast(this, foe, w);
      w.fx.push(new CastRing(this.x, this.y, 60, slot.def.color || '#ffffff'));
    }

    takeDamage(amount, kind) {
      const w = this.world;
      amount = amount * (CFG.dmgMul || 1);
      if (this.invuln > 0) {
        w.popText(this.x, this.y - 150, '无敌', '#8ad8ff', 24);
        return;
      }
      amount = Math.max(0, amount);
      if (this.shield > 0) {
        const absorb = Math.min(this.shield, amount);
        this.shield -= absorb;
        amount -= absorb;
      }
      if (amount <= 0) { w.popText(this.x, this.y - 150, '护盾', '#8ad8ff', 24); return; }
      this.hp = Math.max(0, this.hp - amount);
      this.hitFlash = 1;
      w.shake = Math.min(16, 5 + amount / 30);
      w.popText(this.x + w.rand(-24, 24), this.y - 120, '-' + Math.round(amount), kind === 'self' ? COLOR.green : COLOR.red, 26 + Math.min(22, amount / 6));
      w.burst(this.x, this.y, kind === 'self' ? COLOR.green : COLOR.red, 10);
      if (this.hp <= 0) w.onDeath(this);
    }

    knockback(nx, ny, power) {
      this.vx = nx * power;
      this.vy = ny * power;
      this.knock = 0.5;
    }

    heal(amount) {
      if (!this.alive) return;
      const before = this.hp;
      this.hp = Math.min(this.maxHp, this.hp + amount);
      const real = Math.round(this.hp - before);
      if (real <= 0) return;
      const w = this.world;
      w.popText(this.x, this.y - 120, '+' + real, '#4fa85c', 26);
      w.burst(this.x, this.y, '#7fd08a', 10);
    }

    draw(g) {
      const w = this.world;
      g.save();
      g.translate(this.x, this.y);
      // 影子
      g.fillStyle = 'rgba(6,40,56,.20)';
      g.beginPath(); g.ellipse(0, 82, 56, 14, 0, 0, TAU); g.fill();

      g.save();
      g.scale(this.face, 1);
      if (this.hitFlash > 0) { g.shadowColor = 'rgba(255,255,255,.95)'; g.shadowBlur = 26 * this.hitFlash; }
      this.def.draw(g, this);
      g.restore();

      // 冲刺拖尾
      if (this.dash) {
        g.globalAlpha = 0.35;
        g.fillStyle = '#ffffff';
        g.beginPath(); g.ellipse(-this.face * 60, 30, 45, 16, 0, 0, TAU); g.fill();
        g.globalAlpha = 1;
      }

      // 眩晕：头顶转圈的小星星
      if (this.stun > 0) {
        for (let i = 0; i < 3; i++) {
          const ang = this.age * 7 + i * (TAU / 3);
          g.save();
          g.translate(Math.cos(ang) * 46, -104 + Math.sin(ang) * 10);
          drawStar(g, 0, 0, 12, '#ffe066');
          g.restore();
        }
      }
      g.restore();
    }
  }

  /* ---------- 投掷物：石块 ---------- */
  class Rock extends Entity {
    constructor(owner, x, y, vx, vy, dmg, bounces) {
      super();
      this.owner = owner;
      this.x = x; this.y = y;
      this.vx = vx; this.vy = vy;
      this.r = 26;
      this.dmg = dmg;
      this.bounces = bounces;
      this.spin = 0;
      this.life = 3.2;
    }
    update(dt, w) {
      this.age += dt; this.life -= dt;
      this.spin += dt * 6;
      this.x += this.vx * dt; this.y += this.vy * dt;
      const a = CFG.arena;
      let hit = false;
      if (this.x - this.r < a.x) { this.x = a.x + this.r; this.vx = Math.abs(this.vx); hit = true; }
      if (this.x + this.r > a.x + a.w) { this.x = a.x + a.w - this.r; this.vx = -Math.abs(this.vx); hit = true; }
      if (this.y - this.r < a.y) { this.y = a.y + this.r; this.vy = Math.abs(this.vy); hit = true; }
      if (this.y + this.r > a.y + a.h) { this.y = a.y + a.h - this.r; this.vy = -Math.abs(this.vy); hit = true; }
      if (hit) {
        if (this.bounces-- <= 0) { this.dead = true; w.burst(this.x, this.y, '#9a8f85', 8); }
      }
      if (this.life <= 0) this.dead = true;

      const foe = w.enemyOf(this.owner);
      if (foe && foe.alive && dist(this, foe) < this.r + foe.r) {
        foe.takeDamage(this.dmg, 'attack');
        this.dead = true;
        w.burst(this.x, this.y, '#9a8f85', 12);
      }
    }
    draw(g) {
      g.save();
      g.translate(this.x, this.y);
      g.rotate(this.spin);
      g.fillStyle = '#8d8178';
      g.strokeStyle = '#5d5349';
      g.lineWidth = 3;
      g.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        const rr = this.r * (0.93 + 0.11 * Math.sin(i * 1.9 + 0.4));
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = 'rgba(0,0,0,.18)';
      g.beginPath(); g.arc(-7, -5, 5, 0, TAU); g.fill();
      g.beginPath(); g.arc(8, 6, 4, 0, TAU); g.fill();
      g.restore();
    }
  }

  /* ---------- 子弹：豌豆 ---------- */
  class Pea extends Entity {
    constructor(owner, x, y, ang, speed, dmg, r) {
      super();
      this.owner = owner;
      this.x = x; this.y = y;
      this.vx = Math.cos(ang) * speed;
      this.vy = Math.sin(ang) * speed;
      this.r = r || 14;
      this.dmg = dmg;
      this.life = 2.4;
      this.spin = 0;
    }
    update(dt, w) {
      this.age += dt;
      this.life -= dt;
      this.spin += dt * 7;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      // 只在擂台范围内飞行，飞出边界就消失
      const a = CFG.arena;
      if (this.life <= 0 ||
          this.x < a.x - 6 || this.x > a.x + a.w + 6 ||
          this.y < a.y - 6 || this.y > a.y + a.h + 6) {
        this.dead = true;
        return;
      }
      const foe = w.enemyOf(this.owner);
      if (foe && foe.alive && dist(this, foe) < this.r + foe.r) {
        foe.takeDamage(this.dmg, 'attack');
        this.dead = true;
        w.burst(this.x, this.y, '#9ede5a', 8);
      }
    }
    draw(g) {
      const im = IMG.pea;
      const d = this.r * 2.3 * ART.pea.scale;
      if (im && im.complete && im.naturalWidth) {
        g.save();
        g.translate(this.x, this.y);
        g.rotate(this.spin * 0.35);
        g.drawImage(im, -d / 2, -d / 2, d, d);
        g.restore();
      } else {
        g.save();
        g.fillStyle = '#9ede5a';
        g.beginPath(); g.arc(this.x, this.y, this.r, 0, TAU); g.fill();
        g.restore();
      }
    }
  }

  // 炮口位置（随角色朝向翻转）
  function muzzleOf(f) {
    return { x: f.x + f.face * ART.muzzle.x, y: f.y + ART.muzzle.y };
  }

  // 发射一颗豌豆；opt.spread 是角度抖动的半幅（度）
  function firePea(f, foe, w, opt) {
    const m = muzzleOf(f);
    const base = Math.atan2(foe.y - 6 - m.y, foe.x - m.x);
    const ang = base + w.rand(-1, 1) * ((opt.spread || 3) * Math.PI / 180);
    w.entities.push(new Pea(f, m.x, m.y, ang, opt.speed || 620, opt.dmg || 14, opt.r || 13));
    w.sparks.push(new Spark(m.x, m.y, Math.cos(ang) * 140, Math.sin(ang) * 140, '#e6ffb0', 6));
  }

  // 大招：2 秒内在正前方 30° 扇形里疯狂扫射
  function startPeaUlt(f, w) {
    if (f.ult > 0) return;
    f.burst = 0;
    f.ult = 2.0;
    f.ultAcc = 0;
    w.shake = Math.min(w.shake + 7, 16);
    w.fx.push(new CastRing(f.x, f.y, 150, '#e5453f'));
    w.popText(f.x, f.y - 168, '大招·疯狂连发！', '#e5453f', 30);
  }
  // 五角星
  function drawStar(g, cx, cy, r, color) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r : r * 0.45;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.strokeStyle = 'rgba(120,80,0,.55)';
    g.lineWidth = 2;
    g.stroke();
  }

  // 角度归一化到 [-PI, PI]
  function normAngle(a) {
    while (a > Math.PI) a -= TAU;
    while (a < -Math.PI) a += TAU;
    return a;
  }

  // 网球拍挥击：扇形近战 + 反弹子弹 + 击退（技能与自动弹反共用）
  function racketSwing(f, w, aimAng) {
    const foe = w.enemyOf(f);
    f.face = Math.cos(aimAng) >= 0 ? 1 : -1;
    w.fx.push(new RacketSwing(f.x, f.y - 8, f.face));

    // ① 反弹正面扇形内的敌方子弹
    let reflected = 0;
    for (const e of w.entities) {
      if (e === f || e.owner === f) continue;
      if (typeof e.dmg !== 'number' || typeof e.vx !== 'number') continue;
      if (dist(e, f) > 410) continue;
      if (Math.abs(normAngle(Math.atan2(e.y - f.y, e.x - f.x) - aimAng)) > 0.95) continue;
      const back = (foe && foe.alive) ? Math.atan2(foe.y - e.y, foe.x - e.x) : aimAng;
      const sp = Math.max(520, Math.hypot(e.vx, e.vy) * 1.25);
      e.vx = Math.cos(back) * sp;
      e.vy = Math.sin(back) * sp;
      e.owner = f;
      e.dmg = Math.round(e.dmg * 1.5);
      reflected++;
      w.burst(e.x, e.y, '#ffe066', 6);
    }

    // ② 扇形内的近战命中 + 击退
    if (foe && foe.alive) {
      const d2 = dist(f, foe);
      if (d2 < 410 && Math.abs(normAngle(Math.atan2(foe.y - f.y, foe.x - f.x) - aimAng)) < 0.95) {
        foe.takeDamage(96, 'attack');
        const nx = (foe.x - f.x) / (d2 || 1);
        const ny = (foe.y - f.y) / (d2 || 1);
        foe.knockback(nx, ny, 1900);
        w.shake = Math.min(16, w.shake + 7);
      }
    }
    if (reflected > 0) w.popText(f.x, f.y - 150, '反弹 ×' + reflected, '#ffe066', 26);
    return reflected;
  }
  /* ---------- 技能实体：合约仓位（股票技能） ---------- */
  class StockGem extends Entity {
    constructor(owner, dir, lev, margin, fuse) {
      super();
      this.owner = owner;
      this.dir = dir;           // 1 多 / -1 空
      this.lev = lev;
      this.margin = margin;
      this.entry = owner.world.price;
      this.fuse = fuse;
      this.x = owner.x;
      this.y = owner.y;
      this.r = 26;
      this.wob = Math.random() * TAU;
    }
    get pnl() {
      return this.margin * this.lev * ((this.owner.world.price / this.entry) - 1) * this.dir;
    }
    update(dt, w) {
      this.age += dt;
      // 悬在施法者身边（跟随，避免跑没了看不见）
      const o = this.owner;
      const tx = o.x + (o.face > 0 ? -108 : 108);
      const ty = o.y - 16;
      this.x = lerp(this.x, tx, Math.min(1, dt * 6));
      this.y = lerp(this.y, ty, Math.min(1, dt * 6));

      if (this.age >= this.fuse) {
        this.dead = true;
        const foe = w.enemyOf(this.owner);
        const pnl = this.pnl;
        const target = pnl >= 0 ? foe : this.owner;
        if (target && target.alive) {
          target.takeDamage(Math.abs(pnl), pnl >= 0 ? 'attack' : 'self');
        }
        w.popText(this.x, this.y - 60, pnl >= 0 ? '盈利结算' : '亏损结算', pnl >= 0 ? COLOR.red : COLOR.green, 22);
        w.burst(this.x, this.y, pnl >= 0 ? COLOR.red : COLOR.green, 18);
        w.fx.push(new CastRing(this.x, this.y, 90, pnl >= 0 ? COLOR.red : COLOR.green));
      }
    }
    draw(g) {
      const left = Math.max(0, this.fuse - this.age);
      const pnl = this.pnl;
      g.save();
      g.translate(this.x, this.y + Math.sin(this.age * 3 + this.wob) * 5);
      g.rotate(Math.sin(this.age * 2) * 0.1);

      const col = this.dir === 1 ? COLOR.red : COLOR.purple;
      g.fillStyle = col;
      g.strokeStyle = 'rgba(255,255,255,.75)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(0, -32); g.lineTo(24, -6); g.lineTo(0, 28); g.lineTo(-24, -6);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = 'rgba(255,255,255,.92)';
      g.fillRect(-2, -16, 4, 26);
      g.fillRect(-7, this.dir === 1 ? -12 : 4, 14, 6);
      g.restore();

      // 实时浮盈浮亏：让“技能效果”看得见
      g.save();
      g.textAlign = 'center';
      g.font = '800 20px "Microsoft YaHei",sans-serif';
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(255,255,255,.9)';
      const txt = (pnl >= 0 ? '+' : '') + pnl.toFixed(0);
      g.strokeText(txt, this.x, this.y + 58);
      g.fillStyle = pnl >= 0 ? COLOR.red : COLOR.green;
      g.fillText(txt, this.x, this.y + 58);

      g.font = '700 16px "Microsoft YaHei",sans-serif';
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.fillText(this.dir === 1 ? '多' : '空', this.x, this.y - 44);
      g.fillText(left.toFixed(1) + 's', this.x, this.y + 82);
      g.restore();
    }
  }

  /* ---------- 表现层实体 ---------- */
  class CastRing extends Entity {
    constructor(x, y, r, color) { super(); this.x = x; this.y = y; this.r = r; this.color = color; this.life = 0.35; this.t = 0; }
    update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; }
    draw(g) {
      const k = this.t / this.life;
      g.save();
      g.globalAlpha = 1 - k;
      g.strokeStyle = this.color;
      g.lineWidth = 4;
      g.beginPath(); g.arc(this.x, this.y, this.r * (0.4 + k * 0.9), 0, TAU); g.stroke();
      g.restore();
    }
  }

  class WhipSlash extends Entity {
    constructor(x, y, face, color) { super(); this.x = x; this.y = y; this.face = face; this.color = color || '#ffe9a8'; this.life = 0.26; this.t = 0; }
    update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; }
    draw(g) {
      const k = this.t / this.life;
      g.save();
      g.translate(this.x, this.y);
      g.scale(this.face, 1);
      g.globalAlpha = 1 - k;
      g.strokeStyle = this.color;
      g.lineWidth = 10 * (1 - k * 0.5);
      g.lineCap = 'round';
      g.beginPath();
      g.arc(0, 0, 150, -1.1 + k * 0.5, 0.9 + k * 0.5);
      g.stroke();
      g.restore();
    }
  }

  /* ---------- 表现：网球拍挥击（扇形） ---------- */
  class RacketSwing extends Entity {
    constructor(x, y, dir) {
      super();
      this.x = x; this.y = y;
      this.dir = dir;
      this.life = 0.3;
      this.t = 0;
    }
    update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; }
    draw(g) {
      const k = Math.min(1, this.t / this.life);
      const from = -0.95, to = -0.95 + 1.9 * Math.min(1, k * 1.7);
      g.save();
      g.translate(this.x, this.y);
      g.scale(this.dir, 1);

      // 扇形范围提示（半径 = 实际攻击半径）
      g.globalAlpha = 0.22 * (1 - k);
      g.fillStyle = '#ffd94a';
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 410, -0.95, 0.95); g.closePath(); g.fill();

      // 挥拍残影
      g.globalAlpha = (1 - k) * 0.9;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 16;
      g.lineCap = 'round';
      g.beginPath(); g.arc(0, 0, 300, -0.95, to); g.stroke();

      // 球拍
      g.globalAlpha = 1 - k * 0.6;
      g.save();
      g.rotate(to);
      g.translate(300, 0);
      g.scale(1.9, 1.9);
      g.rotate(-0.35);
      g.strokeStyle = '#1b2a3a';
      g.lineWidth = 7;
      g.beginPath(); g.moveTo(-64, 0); g.lineTo(-26, 0); g.stroke();
      g.fillStyle = '#2f6fd0';
      g.strokeStyle = '#eaf2ff';
      g.lineWidth = 4;
      g.beginPath(); g.ellipse(0, 0, 30, 22, 0, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.75)';
      g.lineWidth = 1.5;
      for (let i = -2; i <= 2; i++) {
        g.beginPath(); g.moveTo(i * 10, -18); g.lineTo(i * 10, 18); g.stroke();
        g.beginPath(); g.moveTo(-25, i * 7); g.lineTo(25, i * 7); g.stroke();
      }
      g.restore();
      g.restore();
    }
  }
  /* ---------- 多段近战：连爪 ---------- */
  class MultiStrike extends Entity {
    constructor(owner, target, hits, dmg, interval, range, color) {
      super();
      this.owner = owner; this.target = target;
      this.hits = hits; this.dmg = dmg;
      this.interval = interval; this.range = range;
      this.done = 0; this.t = 0; this.next = interval * 0.6;
      this.color = color || '#ffd27f';
    }
    update(dt, w) {
      this.t += dt;
      if (this.t < this.next) return;
      this.next += this.interval;
      if (this.target.alive && dist(this.owner, this.target) < this.range) {
        this.target.takeDamage(this.dmg, 'attack');
        w.fx.push(new Slash(this.owner.x + this.owner.face * 46, this.owner.y - 6, this.owner.face, this.color));
      }
      if (++this.done >= this.hits) this.dead = true;
    }
    draw() {}
  }

  class Slash extends Entity {
    constructor(x, y, face, color) { super(); this.x = x; this.y = y; this.face = face; this.color = color; this.life = 0.2; this.t = 0; }
    update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; }
    draw(g) {
      const k = this.t / this.life;
      g.save();
      g.translate(this.x, this.y);
      g.scale(this.face, 1);
      g.globalAlpha = 1 - k;
      g.strokeStyle = this.color;
      g.lineWidth = 7 * (1 - k * 0.4);
      g.lineCap = 'round';
      g.beginPath(); g.arc(0, 0, 58, -0.9 + k * 0.4, 0.9 + k * 0.4); g.stroke();
      g.restore();
    }
  }

  /* ---------- 投掷物：胡萝卜 ---------- */
  class Carrot extends Rock {
    constructor(owner, x, y, vx, vy, dmg, bounces) {
      super(owner, x, y, vx, vy, dmg, bounces);
      this.r = 22;
    }
    draw(g) {
      g.save();
      g.translate(this.x, this.y);
      g.rotate(this.spin * 0.7);
      g.fillStyle = '#f08a3c';
      g.strokeStyle = '#b45f1e';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(0, 22); g.lineTo(-13, -10); g.lineTo(13, -10); g.closePath();
      g.fill(); g.stroke();
      g.fillStyle = '#4fa85c';
      g.beginPath(); g.ellipse(-6, -17, 5, 11, 0.5, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(6, -17, 5, 11, -0.5, 0, TAU); g.fill();
      g.restore();
    }
  }
  class TextPop extends Entity {
    constructor(x, y, text, color, size) {
      super(); this.x = x; this.y = y; this.text = text; this.color = color; this.size = size;
      this.life = 1.1; this.t = 0; this.vy = -70;
    }
    update(dt) { this.t += dt; this.y += this.vy * dt; this.vy *= 0.93; if (this.t >= this.life) this.dead = true; }
    draw(g) {
      const a = clamp(1 - this.t / this.life, 0, 1);
      g.save();
      g.globalAlpha = a;
      g.textAlign = 'center';
      g.font = '800 ' + this.size + 'px "Microsoft YaHei",sans-serif';
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.strokeText(this.text, this.x, this.y);
      g.fillStyle = this.color;
      g.fillText(this.text, this.x, this.y);
      g.restore();
    }
  }

  class Spark {
    constructor(x, y, vx, vy, color, size) {
      this.x = x; this.y = y; this.vx = vx; this.vy = vy;
      this.color = color; this.size = size;
      this.life = 0.5 + Math.random() * 0.3; this.t = 0;
    }
  }

  // ======================= 3. 技能表 =======================
  // 一个技能 = { 名字, 冷却, 是否耗弹药, 施法条件 canCast, 施法效果 cast }
  // 「效果原语」：投掷物 / 延迟结算 / 近战判定 / 位移 / 增益 ……
  const SKILLS = {
    // —— 弹药型投射：石块 ——
    rock: {
      name: '石块', color: '#c8beb2', cd: 0.85, ammo: 1,
      cast(f, foe, w) {
        f.ammo.cur -= 1;
        const ang = Math.atan2(foe.y - f.y, foe.x - f.x) + w.rand(-0.12, 0.12);
        const sp = 460;
        w.entities.push(new Rock(f, f.x + Math.cos(ang) * 50, f.y + Math.sin(ang) * 50,
          Math.cos(ang) * sp, Math.sin(ang) * sp, 46, 2));
      },
      canCast(f) { return f.ammo.cur >= 1; },
      urge: (f, foe, w) => 0.85,
    },

    // —— 延迟结算：合约开仓（就是“股票”那个技能）——
    stock: {
      name: '合约', color: '#e5453f', cd: 7.5,
      cast(f, foe, w) {
        const dir = w.rand(0, 1) < 0.5 ? 1 : -1;
        const lev = [10, 20, 50][Math.floor(w.rand(0, 3))];
        const margin = [100, 200][Math.floor(w.rand(0, 2))];
        w.entities.push(new StockGem(f, dir, lev, margin, w.rand(6, 9)));
        w.priceOpen = true;   // 打开行情面板
      },
      urge: () => 0.9,
    },

    // —— 近战判定：鞭击 ——
    whip: {
      name: '鞭击', color: '#ffe9a8', cd: 3.6,
      cast(f, foe, w) {
        f.face = foe.x >= f.x ? 1 : -1;
        w.fx.push(new WhipSlash(f.x, f.y - 10, f.face));
        const d = dist(f, foe);
        if (d < 175 && (foe.x - f.x) * f.face > -20) {
          foe.takeDamage(78, 'attack');
          foe.randomDeflect(w, 2.2);
        }
      },
      canCast: (f, foe) => dist(f, foe) < 320,
      urge: (f, foe) => (dist(f, foe) < 200 ? 0.95 : 0.15),
    },

    // —— 位移 + 接触伤害：滑铲 ——
    slide: {
      name: '滑铲', color: '#8ad8ff', cd: 5.2,
      cast(f, foe, w) {
        const ang = Math.atan2(foe.y - f.y, foe.x - f.x);
        f.vx = Math.cos(ang) * 720;
        f.vy = Math.sin(ang) * 720;
        f.face = Math.cos(ang) >= 0 ? 1 : -1;
        f.dash = { t: 0.34, hit: false };
        f.dashCheck = () => {
          if (dist(f, foe) < f.r + foe.r + 8) {
            foe.takeDamage(68, 'attack');
            foe.randomDeflect(w, 3);
            f.dash = null;
            f.speed = w.rand(f.spdMin, f.spdMax);
          }
        };
      },
      canCast: (f, foe) => dist(f, foe) > 220 && dist(f, foe) < 640,
      urge: (f, foe) => 0.6,
    },

    // —— 增益：护盾 ——
    shield: {
      name: '护盾', color: '#8ad8ff', cd: 9,
      cast(f) { f.shield = 300; },
      canCast: (f) => f.shield <= 0,
      urge: (f, foe, w) => (f.hp < f.maxHp * 0.55 ? 0.9 : 0.2),
    },
  };

  // —— 追加技能（数据驱动：加技能只动这里）——
  Object.assign(SKILLS, {
    // 多段近战
    claw: {
      name: '连爪', color: '#ffd27f', cd: 2.4,
      canCast: (f, foe) => dist(f, foe) < 250,
      urge: (f, foe) => (dist(f, foe) < 215 ? 0.95 : 0.1),
      cast(f, foe, w) {
        f.face = foe.x >= f.x ? 1 : -1;
        w.entities.push(new MultiStrike(f, foe, 3, 30, 0.16, 220, '#ffd27f'));
      },
    },
    // 位移突进
    pounce: {
      name: '扑击', color: '#ffd27f', cd: 5.5,
      canCast: (f, foe) => dist(f, foe) > 160 && dist(f, foe) < 700,
      urge: () => 0.55,
      cast(f, foe, w) {
        const ang = Math.atan2(foe.y - f.y, foe.x - f.x);
        f.vx = Math.cos(ang) * 800;
        f.vy = Math.sin(ang) * 800;
        f.face = Math.cos(ang) >= 0 ? 1 : -1;
        f.dash = { t: 0.3, hit: false };
        f.dashCheck = () => {
          if (dist(f, foe) < f.r + foe.r + 10) {
            foe.takeDamage(74, 'attack');
            foe.randomDeflect(w, 3);
            f.dash = null;
            f.speed = w.rand(f.spdMin, f.spdMax);
          }
        };
      },
    },
    // 高弹跳投掷物
    carrot: {
      name: '胡萝卜', color: '#f08a3c', cd: 1.5,
      urge: () => 0.8,
      cast(f, foe, w) {
        const ang = Math.atan2(foe.y - f.y, foe.x - f.x) + w.rand(-0.15, 0.15);
        const sp = 400;
        w.entities.push(new Carrot(f, f.x + Math.cos(ang) * 52, f.y + Math.sin(ang) * 52,
          Math.cos(ang) * sp, Math.sin(ang) * sp, 40, 4));
      },
    },
    // 机枪豌豆：一次四发，依次射出（不是扇形）；每颗子弹 3% 概率直接开大
    peaShot: {
      name: '豌豆', color: '#8fd34a', cd: 0.95,
      urge: () => 0.95,
      cast(f, foe, w) {
        f.face = foe.x >= f.x ? 1 : -1;
        firePea(f, foe, w, { spread: 2.5, dmg: 14, speed: 680 });   // 第一发立即出膛
        if (w.rand(0, 1) < 0.03) { startPeaUlt(f, w); return; }
        f.burst = 3;        // 剩下 3 发排队，按 burstTick 间隔依次射出
        f.burstAcc = 0;
      },
    },    // 网球拍挥击：正面扇形近战，能反弹对手子弹，命中击退
    racket: {
      name: '挥拍', color: '#ffd94a', cd: 2.3,
      canCast: (f, foe) => dist(f, foe) < 640,
      urge: (f, foe) => (dist(f, foe) < 480 ? 0.95 : 0.3),
      cast(f, foe, w) {
        racketSwing(f, w, Math.atan2(foe.y - f.y, foe.x - f.x));
      },
    },    // 冲刺：短距离突进，期间无敌；冲刺撞人不掉转速
    dash: {
      name: '冲刺', color: '#8ad8ff', cd: 3.6,
      canCast: (f, foe) => { const d = dist(f, foe); return d > 110 && d < 620; },
      urge: (f, foe) => (dist(f, foe) < 420 ? 0.7 : 0.25),
      cast(f, foe, w) {
        const ang = Math.atan2(foe.y - f.y, foe.x - f.x);
        f.vx = Math.cos(ang) * 900;
        f.vy = Math.sin(ang) * 900;
        f.face = Math.cos(ang) >= 0 ? 1 : -1;
        f.invuln = 0.34;
        f.dash = { t: 0.34, hit: false };
        w.fx.push(new CastRing(f.x, f.y, 76, '#8ad8ff'));
        w.burst(f.x, f.y, '#bfe9ff', 8);
      },
    },    // 治疗（新的效果原语：增益）
    heal: {
      name: '回血', color: '#4fa85c', cd: 10,
      canCast: (f) => f.hp < f.maxHp * 0.72,
      urge: (f) => (f.hp < f.maxHp * 0.5 ? 0.95 : 0.25),
      cast(f, foe, w) {
        f.heal(240);
        w.fx.push(new CastRing(f.x, f.y, 80, '#4fa85c'));
      },
    },
  });
  // ======================= 4. 角色表 =======================
  // 一个角色 = 属性 + 立绘函数 + 技能 key 列表（想加角色只改这里）
  const CHARS = {
    penguin: {
      name: '凑企鹅', hpBonus: 150,
      skills: ['rock', 'slide'],
      draw(g) { drawPenguin(g); },
    },
  };

  // —— 追加角色 ——
  Object.assign(CHARS, {
    cat: {
      name: '猫猫', hpBonus: -220, speedBonus: 30,
      skills: ['claw', 'pounce', 'shield'],
      draw(g) { drawCat(g); },
    },
    rabbit: {
      name: '兔兔', hpBonus: 60, speedBonus: -12,
      skills: ['carrot', 'heal'],
      draw(g) { drawRabbit(g); },
    },
    gatling: {
      name: '超级机枪豌豆射手', hpBonus: -60, speedBonus: -26,
      skills: ['peaShot', 'shield'],
      draw(g) { drawGatling(g); },
    },
    jiaoge: {
      name: '叫哥', hpBonus: 140, speedBonus: -12,
      skills: ['racket', 'shield'],
      draw(g) { drawJiaoge(g); },
    },
    tuberr: {
      name: 'tuberr', hpBonus: 60, speedBonus: -6,
      spinner: true,
      skills: ['dash', 'shield'],
      draw(g, f) { drawTuberr(g, f); },
    },
  });

  // ======================= 5. 世界 =======================
  class World {
    constructor(seed, keyA, keyB) {
      this.rng = mulberry32(seed || Date.now());
      this.entities = [];
      this.fx = [];
      this.pops = [];
      this.sparks = [];
      this.shake = 0;
      this.time = 0;
      this.over = false;
      this.winner = null;

      // 行情子系统：只有「合约」技能在用，其他角色完全不需要它
      this.price0 = 3000;
      this.price = 3000;
      this.priceOpen = false;
      this.trend = 0;
      this.candles = [];
      this.curCandle = null;
      this.newCandle();

      const a = CFG.arena;
      this.a = new Fighter(this, keyA || 'penguin', a.x + a.w * 0.26, a.y + a.h * 0.30, 'A');
      this.b = new Fighter(this, keyB || 'rabbit', a.x + a.w * 0.74, a.y + a.h * 0.70, 'B');
      this.fighters = [this.a, this.b];
      this.entities.push(this.a, this.b);
    }

    enemyOf(f) { return f === this.a ? this.b : this.a; }

    rand(a, b) { return a + (b - a) * this.rng(); }

    newCandle() {
      this.curCandle = { o: this.price, h: this.price, l: this.price, c: this.price, t0: this.time };
      this.candles.push(this.curCandle);
      while (this.candles.length > 24) this.candles.shift();
    }

    stepPrice(dt) {
      this.trend += (this.rng() - 0.5) * 0.6 * dt;
      this.trend = clamp(this.trend * Math.pow(0.985, dt), -2.2, 2.2);
      const ret = (this.trend + (this.rng() - 0.5) * 2.0) * dt;
      this.price = Math.max(1, this.price * (1 + ret / 100));
      const c = this.curCandle;
      c.c = this.price;
      c.h = Math.max(c.h, this.price);
      c.l = Math.min(c.l, this.price);
      if (this.time - c.t0 > 1) this.newCandle();
    }

    popText(x, y, text, color, size) { this.pops.push(new TextPop(x, y, text, color, size)); }

    burst(x, y, color, n) {
      for (let i = 0; i < n; i++) {
        const a = this.rand(0, TAU), sp = this.rand(80, 340);
        this.sparks.push(new Spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 60, color, this.rand(3, 7)));
      }
    }

    onDeath(f) {
      if (this.over) return;
      this.over = true;
      this.winner = this.enemyOf(f);
      this.burst(f.x, f.y, '#ffffff', 26);
    }

    // ---- 物理：角色互撞（随机弹开） ----
    resolveFighterCollision(a, b) {
      const d = dist(a, b);
      const minD = a.r + b.r;
      if (d === 0 || d >= minD) return;
      const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
      const push = (minD - d) / 2 + 0.5;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;

      // 交换一部分动量，再各自随机偏转 → “随机碰撞”
      const av = a.vx * nx + a.vy * ny;
      const bv = b.vx * nx + b.vy * ny;
      a.vx += (bv - av) * nx; a.vy += (bv - av) * ny;
      b.vx += (av - bv) * nx; b.vy += (av - bv) * ny;
      a.randomDeflect(this, 1.6);
      b.randomDeflect(this, 1.6);
    }

    update(dt) {
      if (this.over) dt *= 0.25;   // 结束后慢动作
      this.time += dt;
      if (this.priceOpen) this.stepPrice(dt);

      for (const f of this.fighters) {
        if (f.alive) f.update(dt);
        if (f.dash && f.dashCheck) f.dashCheck();
      }
      this.resolveFighterCollision(this.a, this.b);

      for (const e of this.entities) {
        if (e instanceof Fighter) continue;
        e.update(dt, this);
      }
      for (const e of this.fx) e.update(dt, this);

      for (const s of this.sparks) {
        s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 900 * dt;
      }
      this.sparks = this.sparks.filter((s) => s.t < s.life);
      for (const p of this.pops) p.update(dt);
      this.pops = this.pops.filter((p) => !p.dead);

      this.entities = this.entities.filter((e) => !e.dead);
      this.fx = this.fx.filter((e) => !e.dead);
      this.shake *= Math.pow(0.02, dt);
    }

    // ---- 渲染 ----
    render(g) {
      g.save();
      g.clearRect(0, 0, CFG.W, CFG.H);
      const grd = g.createLinearGradient(0, 0, 0, CFG.H);
      grd.addColorStop(0, COLOR.bg1);
      grd.addColorStop(1, COLOR.bg2);
      g.fillStyle = grd;
      g.fillRect(0, 0, CFG.W, CFG.H);

      if (this.shake > 0.4) g.translate(this.rand(-this.shake, this.shake), this.rand(-this.shake, this.shake));

      drawHeader(g, this);
      drawArena(g);

      for (const e of this.entities) e.draw(g);
      for (const e of this.fx) e.draw(g);
      // 血条/名牌单独一层，永远压在角色与特效之上
      for (const f of this.fighters) drawHpPlaque(g, f, f.x, Math.max(200, f.y - 138));
      for (const f of this.fighters) drawNamePlate(g, f);

      // 炮口对位辅助：控制台执行 window.__DEBUG_MUZZLE = 1 即可看到十字
      if (window.__DEBUG_MUZZLE) {
        for (const f of this.fighters) {
          const m = muzzleOf(f);
          g.save();
          g.strokeStyle = '#ff2fd0';
          g.lineWidth = 3;
          g.beginPath(); g.moveTo(m.x - 16, m.y); g.lineTo(m.x + 16, m.y); g.stroke();
          g.beginPath(); g.moveTo(m.x, m.y - 16); g.lineTo(m.x, m.y + 16); g.stroke();
          g.beginPath(); g.arc(m.x, m.y, 6, 0, TAU); g.stroke();
          g.restore();
        }
      }
      for (const s of this.sparks) {
        g.globalAlpha = clamp(1 - s.t / s.life, 0, 1);
        g.fillStyle = s.color;
        g.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size);
        g.globalAlpha = 1;
      }
      for (const p of this.pops) p.draw(g);
      g.restore();
    }
  }

  // ======================= 6. 绘制：通用 UI =======================
  // 白色框本身就是血条：宽度随血量收缩，数字始终居中
  // 小盾牌图标
  function drawShieldIcon(g, cx, cy, r) {
    g.save();
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.85, cy - r * 0.55);
    g.lineTo(cx + r * 0.85, cy + r * 0.15);
    g.quadraticCurveTo(cx, cy + r * 1.05, cx - r * 0.85, cy + r * 0.15);
    g.lineTo(cx - r * 0.85, cy - r * 0.55);
    g.closePath();
    g.fillStyle = '#eaf6ff';
    g.fill();
    g.strokeStyle = '#1b5e88';
    g.lineWidth = 2;
    g.stroke();
    g.restore();
  }

  function drawHpPlaque(g, f, x, y) {
    const hp = f.hp, maxHp = f.maxHp;
    const pct = clamp(hp / maxHp, 0, 1);
    const low = pct < 0.35;
    const wMax = 190, h = 40, r = 11;
    const w = Math.max(30, wMax * pct);
    g.save();

    // 底板（表示“已经掉掉的那部分”）
    g.fillStyle = 'rgba(15,43,58,.34)';
    roundRect(g, x - wMax / 2, y - h / 2, wMax, h, r);
    g.fill();

    // 血条本体（始终白色，低血时只把数字变红，避免看起来像个黑洞）
    g.fillStyle = '#ffffff';
    g.strokeStyle = low ? 'rgba(229,69,63,.85)' : 'rgba(15,43,58,.45)';
    g.lineWidth = 4;
    roundRect(g, x - w / 2, y - h / 2, w, h, r);
    g.fill();
    g.stroke();

    // 数字：白描边保证在“框外”也看得清
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 27px "Microsoft YaHei",sans-serif';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(255,255,255,.95)';
    g.strokeText(Math.round(hp), x, y + 1);
    g.fillStyle = low ? '#e5453f' : COLOR.ink;
    g.fillText(Math.round(hp), x, y + 1);

    // —— 护盾值：贴在血条右侧 ——
    if (f.shield > 0) {
      const label = String(Math.round(f.shield));
      g.font = '800 19px "Microsoft YaHei",sans-serif';
      const tw = g.measureText(label).width;
      const bw = tw + 44;
      let bx = x + wMax / 2 + 8;            // 血条右端外侧
      if (bx + bw > CFG.W - 10) bx = x - wMax / 2 - 8 - bw;   // 贴右墙时改放左边
      const bh = 30;
      // 背板
      g.fillStyle = 'rgba(47,143,208,.95)';
      g.strokeStyle = 'rgba(255,255,255,.85)';
      g.lineWidth = 2;
      roundRect(g, bx, y - bh / 2, bw, bh, 9);
      g.fill();
      g.stroke();
      // 盾牌图标
      g.save();
      g.translate(bx + 15, y);
      drawShieldShape(g, 9);
      g.restore();
      // 数值
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(10,40,60,.35)';
      g.strokeText(label, bx + 28, y + 1);
      g.fillStyle = '#ffffff';
      g.fillText(label, bx + 28, y + 1);
    }

    g.restore();
  }

  // 以 (0,0) 为中心画一个盾形图标
  function drawShieldShape(g, r) {
    g.beginPath();
    g.moveTo(0, -r);
    g.lineTo(r * 0.85, -r * 0.55);
    g.lineTo(r * 0.85, r * 0.15);
    g.quadraticCurveTo(0, r * 1.1, -r * 0.85, r * 0.15);
    g.lineTo(-r * 0.85, -r * 0.55);
    g.closePath();
    g.fillStyle = '#eaf6ff';
    g.fill();
    g.strokeStyle = '#1b5e88';
    g.lineWidth = 2;
    g.stroke();
  }
  function drawNamePlate(g, f) {
    // 角色下方不再显示名字（名字统一放在顶部“A vs B”标题里），只保留技能状态
    const chips = f.skills.map((s) => ({ s: s, wd: s.def.ammo ? 108 : 62 }));
    if (f.ult > 0) chips.push({ ult: true, wd: 100 });
    if (f.spinner) chips.push({ spin: true, wd: 96 });
    const gap = 8;
    const total = chips.reduce((a, c) => a + c.wd, 0) + gap * (chips.length - 1);
    const y = f.y + 116;
    let x = f.x - total / 2;

    g.save();
    g.textAlign = 'center';
    for (const c of chips) {
      if (c.spin) {
        const k = Math.min(1, (f.spin - f.spinMin) / (f.spinMax - f.spinMin));
        g.fillStyle = k > 0.66 ? '#ff9a3c' : (k > 0.33 ? '#ffd94a' : 'rgba(138,216,255,.95)');
        roundRect(g, x, y - 13, c.wd, 26, 7);
        g.fill();
        g.font = '800 14px "Microsoft YaHei",sans-serif';
        g.fillStyle = '#0f2b3a';
        g.fillText('转速 ' + (f.spin / f.spinMin).toFixed(1) + '×', x + c.wd / 2, y + 5);
        x += c.wd + gap;
        continue;
      }
      if (c.ult) {
        g.fillStyle = '#e5453f';
        roundRect(g, x, y - 13, c.wd, 26, 7);
        g.fill();
        g.font = '800 14px "Microsoft YaHei",sans-serif';
        g.fillStyle = '#fff';
        g.fillText('大招 ' + f.ult.toFixed(1) + 's', x + c.wd / 2, y + 5);
        x += c.wd + gap;
        continue;
      }
      const s = c.s;
      const ready = s.cd <= 0.001;
      const label = s.def.ammo
        ? s.def.name + ' ' + Math.floor(f.ammo.cur) + '/' + f.ammo.max
        : s.def.name;
      g.fillStyle = ready ? 'rgba(255,255,255,.92)' : 'rgba(15,43,58,.42)';
      roundRect(g, x, y - 13, c.wd, 26, 7);
      g.fill();
      g.font = '700 14px "Microsoft YaHei",sans-serif';
      g.fillStyle = ready ? COLOR.ink : 'rgba(255,255,255,.8)';
      g.fillText(label, x + c.wd / 2, y + 5);
      if (!ready) {
        const k = 1 - s.cd / s.def.cd;
        g.fillStyle = 'rgba(255,255,255,.6)';
        roundRect(g, x, y + 14, c.wd * k, 4, 2);
        g.fill();
      }
      x += c.wd + gap;
    }
    g.restore();
  }
  function drawHeader(g, w) {
    g.save();
    g.textAlign = 'center';
    g.fillStyle = COLOR.ink;
    const title = (w.a ? w.a.name : '') + ' vs ' + (w.b ? w.b.name : '');
    let size = 56;
    g.font = '800 ' + size + 'px "Microsoft YaHei",sans-serif';
    while (g.measureText(title).width > 760 && size > 26) {
      size -= 2;
      g.font = '800 ' + size + 'px "Microsoft YaHei",sans-serif';
    }
    g.fillText(title, CFG.W / 2, 128);

    g.textAlign = 'right';
    g.font = '700 22px "Microsoft YaHei",sans-serif';
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.fillText(w.over ? '已结束' : '对战中 ' + w.time.toFixed(1) + 's', CFG.W - 62, 84);
    g.restore();
  }

  function drawArena(g) {
    const a = CFG.arena;
    g.save();
    g.strokeStyle = COLOR.frame;
    g.lineWidth = 12;
    g.strokeRect(a.x - 8, a.y - 8, a.w + 16, a.h + 16);
    g.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ======================= 角色立绘 =======================
  function drawPenguin(g) {
    // 企鹅身体
    g.fillStyle = '#2f3540';
    g.strokeStyle = '#1d222a';
    g.lineWidth = 4;
    g.beginPath(); g.ellipse(0, 18, 46, 62, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#f7f4ec';
    g.beginPath(); g.ellipse(0, 24, 30, 46, 0, 0, TAU); g.fill();
    // 脚
    g.fillStyle = '#e0913f';
    g.beginPath(); g.ellipse(-18, 74, 16, 8, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(18, 74, 16, 8, 0, 0, TAU); g.fill();
    // 头发
    g.fillStyle = '#9aa0a8';
    g.beginPath(); g.ellipse(0, -34, 44, 38, 0, 0, TAU); g.fill();
    // 脸
    g.fillStyle = '#ffe6d6';
    g.beginPath(); g.ellipse(0, -22, 34, 34, 0, 0, TAU); g.fill();
    // 刘海
    g.fillStyle = '#9aa0a8';
    g.beginPath(); g.ellipse(0, -46, 36, 20, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(-30, -26, 14, 22, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(30, -26, 14, 22, 0, 0, TAU); g.fill();
    // 眼睛
    g.fillStyle = '#333a44';
    g.beginPath(); g.ellipse(-12, -22, 5, 7, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(12, -22, 5, 7, 0, 0, TAU); g.fill();
    // 嘴
    g.fillStyle = '#e0913f';
    g.beginPath(); g.moveTo(-6, -8); g.lineTo(6, -8); g.lineTo(0, 1); g.closePath(); g.fill();
    // 腮红
    g.fillStyle = 'rgba(240,150,160,.45)';
    g.beginPath(); g.ellipse(-24, -6, 8, 5, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(24, -6, 8, 5, 0, 0, TAU); g.fill();
    // 翅膀
    g.fillStyle = '#2f3540';
    g.beginPath(); g.ellipse(-44, 20, 12, 26, 0.3, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(44, 20, 12, 26, -0.3, 0, TAU); g.fill();
  }

  function drawCat(g) {
    g.strokeStyle = '#c9a86a'; g.lineWidth = 8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-38, 44); g.quadraticCurveTo(-92, 24, -76, -28); g.stroke();

    g.fillStyle = '#f0c98a'; g.strokeStyle = '#b08b4e'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(0, 12, 49, 60, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#fff4e0';
    g.beginPath(); g.ellipse(0, 28, 29, 40, 0, 0, TAU); g.fill();

    [-1, 1].forEach((k) => {
      g.fillStyle = '#f0c98a'; g.strokeStyle = '#b08b4e'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(k * 16, -58); g.lineTo(k * 42, -96); g.lineTo(k * 46, -52); g.closePath();
      g.fill(); g.stroke();
      g.fillStyle = '#f3b6c6';
      g.beginPath(); g.moveTo(k * 22, -62); g.lineTo(k * 37, -86); g.lineTo(k * 39, -58); g.closePath(); g.fill();
    });

    g.fillStyle = '#f0c98a'; g.strokeStyle = '#b08b4e'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(0, -32, 41, 37, 0, 0, TAU); g.fill(); g.stroke();

    g.fillStyle = '#2b2b2b';
    g.beginPath(); g.ellipse(-15, -34, 6, 8, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(15, -34, 6, 8, 0, 0, TAU); g.fill();

    g.fillStyle = '#e08a8a';
    g.beginPath(); g.moveTo(0, -18); g.lineTo(-6, -12); g.lineTo(6, -12); g.closePath(); g.fill();

    g.strokeStyle = '#b08b4e'; g.lineWidth = 2;
    [-24, -15].forEach((dy) => {
      g.beginPath(); g.moveTo(-18, dy); g.lineTo(-54, dy - 7); g.stroke();
      g.beginPath(); g.moveTo(18, dy); g.lineTo(54, dy - 7); g.stroke();
    });
  }

  function drawRabbit(g) {
    [-1, 1].forEach((k) => {
      g.fillStyle = '#f7f2ea'; g.strokeStyle = '#c9bda9'; g.lineWidth = 4;
      g.beginPath(); g.ellipse(k * 17, -90, 13, 37, k * 0.18, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#f3b6c6';
      g.beginPath(); g.ellipse(k * 17, -90, 6, 25, k * 0.18, 0, TAU); g.fill();
    });

    g.fillStyle = '#f7f2ea'; g.strokeStyle = '#c9bda9'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(0, 18, 45, 57, 0, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(0, -30, 39, 35, 0, 0, TAU); g.fill(); g.stroke();

    g.fillStyle = '#3a3a3a';
    g.beginPath(); g.ellipse(-14, -34, 5, 7, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(14, -34, 5, 7, 0, 0, TAU); g.fill();

    g.fillStyle = 'rgba(244,140,170,.5)';
    g.beginPath(); g.ellipse(-26, -18, 9, 6, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(26, -18, 9, 6, 0, 0, TAU); g.fill();

    g.fillStyle = '#e08a8a';
    g.beginPath(); g.moveTo(0, -22); g.lineTo(-5, -17); g.lineTo(5, -17); g.closePath(); g.fill();

    g.fillStyle = '#f7f2ea';
    g.beginPath(); g.ellipse(-20, 66, 14, 9, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(20, 66, 14, 9, 0, 0, TAU); g.fill();
  }
  // 贴图角色：直接画图片（脚底对齐 y=82，和手绘角色一致）
  function drawGatling(g) {
    const im = IMG.gatling;
    const H = ART.gatling.height;
    if (im && im.complete && im.naturalWidth) {
      const s = H / im.naturalHeight;
      const w2 = im.naturalWidth * s;
      g.drawImage(im, -w2 / 2, ART.gatling.feetY - H, w2, H);
    } else {
      // 图片还没加载完时的占位
      g.fillStyle = '#8fd34a';
      g.strokeStyle = '#4f8a2a';
      g.lineWidth = 4;
      g.beginPath(); g.ellipse(0, 8, 42, 54, 0, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(-13, -16, 9, 0, TAU); g.fill();
      g.beginPath(); g.arc(13, -16, 9, 0, TAU); g.fill();
      g.fillStyle = '#2a2a2a';
      g.beginPath(); g.arc(-13, -16, 4, 0, TAU); g.fill();
      g.beginPath(); g.arc(13, -16, 4, 0, TAU); g.fill();
    }
  }
  // 叫哥：原图朝左，所以绘制时先水平镜像，配合外层 face 翻转正好正确
  function drawJiaoge(g) {
    const im = IMG.jiaoge;
    const H = ART.jiaoge.height;
    if (im && im.complete && im.naturalWidth) {
      const w2 = im.naturalWidth * (H / im.naturalHeight);
      g.save();
      g.scale(-1, 1);
      g.drawImage(im, -w2 / 2, ART.jiaoge.feetY - H, w2, H);
      g.restore();
    } else {
      g.fillStyle = '#3b5ea8';
      g.beginPath(); g.ellipse(0, 20, 44, 58, 0, 0, TAU); g.fill();
      g.fillStyle = '#f0d0b0';
      g.beginPath(); g.arc(0, -42, 30, 0, TAU); g.fill();
    }
  }
  // tuberr：钻石脸，随转速旋转（原图正面，不需要镜像）
  function drawTuberr(g, f) {
    const im = IMG.tuberr;
    const H = ART.tuberr.height;
    const ang = f && typeof f.spinAngle === 'number' ? f.spinAngle : 0;
    if (im && im.complete && im.naturalWidth) {
      const w2 = im.naturalWidth * (H / im.naturalHeight);
      g.save();
      g.translate(0, ART.tuberr.feetY - H / 2 - 10);
      g.rotate(ang);
      g.drawImage(im, -w2 / 2, -H / 2, w2, H);
      g.restore();
      // 转速越快，外圈光晕越亮
      if (f && f.spinner) {
        const k = Math.min(1, (f.spin - f.spinMin) / (f.spinMax - f.spinMin));
        g.save();
        g.globalAlpha = 0.25 + k * 0.45;
        g.strokeStyle = '#8ad8ff';
        g.lineWidth = 4 + k * 6;
        g.beginPath();
        g.arc(0, ART.tuberr.feetY - H / 2 - 10, H * 0.46, ang * 1.6, ang * 1.6 + Math.PI * 1.3);
        g.stroke();
        g.restore();
      }
    } else {
      g.fillStyle = '#7fb8ff';
      g.beginPath();
      g.moveTo(0, -96); g.lineTo(70, 0); g.lineTo(0, 96); g.lineTo(-70, 0);
      g.closePath(); g.fill();
    }
  }
  // ======================= 7. 界面流程 / 主循环 =======================
  const cv = document.getElementById('game');
  const ctx = cv.getContext('2d');
  const banner = document.getElementById('banner');
  const bannerText = document.getElementById('bannerText');
  const bannerSub = document.getElementById('bannerSub');
  const elMenu = document.getElementById('screen-menu');
  const elSelect = document.getElementById('screen-select');
  const elLoading = document.getElementById('screen-loading');
  const loadBar = document.getElementById('loadBar');
  const rosterEl = document.getElementById('roster');
  const slotAName = document.getElementById('slotAName');
  const slotBName = document.getElementById('slotBName');
  const slotAEl = document.getElementById('slotA');
  const slotBEl = document.getElementById('slotB');

  const ORDER = ['penguin', 'cat', 'rabbit', 'gatling', 'jiaoge', 'tuberr'];
  const selection = { a: 'penguin', b: 'rabbit' };
  let activeSlot = 'a';
  let screen = 'menu';            // menu | select | battle
  let world = null;
  let speedMul = 1, acc = 0, last = 0;

  // ---------- 界面切换 ----------
  function showScreen(name) {
    screen = name;
    elMenu.classList.toggle('show', name === 'menu');
    elSelect.classList.toggle('show', name === 'select');
    elLoading.classList.toggle('show', name === 'loading');
    banner.classList.remove('show');
    document.body.classList.toggle('in-battle', name === 'battle');
    document.body.classList.remove('result');
    if (name !== 'battle') world = null;
    if (name !== 'battle') setTimeout(refreshPortraits, 0);   // 界面切回来时头像总能刷新一次
  }

  // ---------- 选人界面 ----------
  // 头像画布登记表：贴图晚到时统一重画，避免停在占位图形上
  const portraits = [];

  function drawPortrait(canvas, key) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H * 0.56);
    g.scale(W / 210, W / 210);
    CHARS[key].draw(g, 0);
    g.restore();

    if (!canvas.__portraitKey) portraits.push(canvas);
    canvas.__portraitKey = key;
  }

  function refreshPortraits() {
    for (let i = portraits.length - 1; i >= 0; i--) {
      const cv = portraits[i];
      if (!cv.isConnected) { portraits.splice(i, 1); continue; }
      drawPortrait(cv, cv.__portraitKey);
    }
  }

  function buildRoster() {
    rosterEl.innerHTML = '';
    ORDER.forEach((key) => {
      const c = CHARS[key];
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.char = key;
      card.innerHTML =
        '<canvas width="200" height="200"></canvas>' +
        '<b>' + c.name + '</b>' +
        '<span class="sk">' + c.skills.map((k) => SKILLS[k].name).join(' · ') + '</span>';
      rosterEl.appendChild(card);
      drawPortrait(card.querySelector('canvas'), key);
      card.addEventListener('click', () => assignChar(key));
    });
  }

  function assignChar(key) {
    selection[activeSlot] = key;
    activeSlot = activeSlot === 'a' ? 'b' : 'a';
    syncSelectUI();
  }

  function syncSelectUI() {
    slotAName.textContent = CHARS[selection.a].name;
    slotBName.textContent = CHARS[selection.b].name;

    slotAEl.classList.toggle('active', activeSlot === 'a');
    slotBEl.classList.toggle('active', activeSlot === 'b');

    drawPortrait(slotAEl.querySelector('canvas'), selection.a);
    drawPortrait(slotBEl.querySelector('canvas'), selection.b);

    document.querySelectorAll('#roster .card').forEach((card) => {
      const k = card.dataset.char;
      card.classList.toggle('pick-a', selection.a === k);
      card.classList.toggle('pick-b', selection.b === k);
    });
  }

  // ---------- 加载页：贴图没就绪就不进场 ----------
  const spritesNeeded = ['gatling', 'pea', 'jiaoge', 'tuberr'];
  let pendingBattle = false;
  let loadTimer = null;

  function readyCount() {
    return spritesNeeded.filter(spriteReady).length;
  }

  function bootLoading() {
    showScreen('loading');
    const t0 = performance.now();
    if (loadTimer) clearInterval(loadTimer);
    const paint = function () {
      const n = readyCount();
      if (loadBar) loadBar.style.width = Math.round((n / spritesNeeded.length) * 100) + '%';
    };
    paint();
    loadTimer = setInterval(function () {
      paint();
      const ready = readyCount() === spritesNeeded.length;
      const elapsed = performance.now() - t0;
      // 全部就绪且至少显示 500ms（避免闪一下），或者超时 8 秒兜底
      if ((ready && elapsed > 500) || elapsed > 8000) {
        clearInterval(loadTimer);
        loadTimer = null;
        refreshPortraits();
        if (pendingBattle) {
          pendingBattle = false;
          startBattle();
        } else {
          showScreen('menu');
        }
      }
    }, 60);
  }

  function requestBattle() {
    if (readyCount() === spritesNeeded.length) { startBattle(); return; }
    pendingBattle = true;
    bootLoading();
  }
  // ---------- 战斗 ----------
  function startBattle() {
    world = new World((Math.random() * 1e9) | 0, selection.a, selection.b);
    acc = 0; last = 0;
    showScreen('battle');
  }

  function showResult() {
    bannerText.textContent = world.winner.name + '获胜';
    bannerSub.textContent = '用时 ' + world.time.toFixed(1) + ' 秒 · 剩余血 ' +
      Math.round(world.winner.hp) + ' / ' + world.winner.maxHp;
    document.body.classList.add('result');
    banner.classList.add('show');
  }

  // ---------- 主界面 / 选人时的展示场景 ----------
  // ---------- 主循环 ----------
  function loop(ts) {
    if (!last) last = ts;
    let frame = (ts - last) / 1000;
    last = ts;
    frame = Math.min(frame, 0.1);

    if (screen === 'battle' && world) {
      acc += frame * speedMul;
      let steps = 0;
      while (acc >= CFG.step && steps < CFG.maxSteps) {
        world.update(CFG.step);
        acc -= CFG.step;
        steps++;
      }
      if (steps === CFG.maxSteps) acc = 0;
      world.render(ctx);
      if (world.over && !banner.classList.contains('show')) showResult();
    } else {
      ctx.clearRect(0, 0, CFG.W, CFG.H);
    }
    requestAnimationFrame(loop);
  }

  // ---------- 按钮绑定 ----------
  document.getElementById('btnStart').addEventListener('click', () => showScreen('select'));
  document.getElementById('btnBackMenu').addEventListener('click', () => showScreen('menu'));
  document.getElementById('btnFight').addEventListener('click', requestBattle);
  document.getElementById('btnRand').addEventListener('click', () => {
    do {
      selection.a = ORDER[Math.floor(Math.random() * ORDER.length)];
      selection.b = ORDER[Math.floor(Math.random() * ORDER.length)];
    } while (selection.a === selection.b);
    syncSelectUI();
  });
  slotAEl.addEventListener('click', () => { activeSlot = 'a'; syncSelectUI(); });
  slotBEl.addEventListener('click', () => { activeSlot = 'b'; syncSelectUI(); });

  document.getElementById('againBtn').addEventListener('click', startBattle);
  document.getElementById('btnChange').addEventListener('click', () => showScreen('select'));
  document.getElementById('btnHome').addEventListener('click', () => showScreen('menu'));
  document.getElementById('restartTop').addEventListener('click', startBattle);

  document.querySelectorAll('button[data-speed]').forEach((b) => {
    b.addEventListener('click', () => {
      speedMul = +b.dataset.speed;
      document.querySelectorAll('button[data-speed]').forEach((o) => o.classList.toggle('active', o === b));
    });
  });

  window.addEventListener('keydown', (e) => {
    if (screen !== 'menu' && screen !== 'select') return;
    if (e.code === 'Escape') showScreen('menu');
    if (e.code === 'Space') {
      e.preventDefault();
      if (screen === 'menu') showScreen('select');
      else requestBattle();
    }
  });

  // ---------- 启动 ----------
  buildRoster();
  syncSelectUI();
  bootLoading();      // 贴图加载完再进主界面
  [100, 500, 1500, 3000].forEach(function (ms) { setTimeout(refreshPortraits, ms); });
  requestAnimationFrame(loop);

  window.__W = () => world;          // 调试：控制台查看世界
  window.__REFRESH_PORTRAITS = refreshPortraits;   // 调试：手动重画所有头像
  window.__IMG = IMG;                             // 调试：查看贴图加载状态
  window.__SELECT = selection;       // 调试：当前选人
})();