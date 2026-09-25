/**
 * 每日领 VIP - EchoMusic 插件
 *
 * 复刻内置的「每日权益」逻辑：
 *   1. 用服务器时间（北京时间）算出今天日期
 *   2. GET /youth/day/vip        领取畅听会员（TVIP）
 *   3. GET /youth/day/vip/upgrade 升级概念会员（SVIP，297002 视为已升级）
 *   4. GET /youth/month/vip/record 判断今日是否已领取，避免重复请求
 *   5. GET /user/vip/detail       读取当前生效的会员及到期时间
 */

const SETTINGS_KEY = "settings";

const DEFAULTS = {
  auto: true, // 开启自动领取
  intervalHours: 1, // 自动检查间隔（小时）
  notify: true, // 自动领取成功后弹提示
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const BOOT_RETRY = 10; // 启动时探测登录态的重试次数
const BOOT_RETRY_DELAY = 2500; // 每次重试间隔（ms）
const AUTO_MIN_GAP = 5 * 60 * 1000; // 事件触发的自动领取最小间隔，避免连续切歌反复打接口
const MAX_UPGRADE_FAILS = 3; // 当日升级失败达到此次数后，当天不再重试（无资格账号防刷）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toBeijingDate = (ms) => new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

const localBeijingDate = () => toBeijingDate(Date.now());

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 兼容 { data } / { body } / 平铺三种响应形态 */
const pickData = (res) => {
  if (!res || typeof res !== "object") return null;
  if (res.data && typeof res.data === "object") return res.data;
  if (res.body && typeof res.body === "object") return res.body;
  return res;
};

const findActiveVip = (vipInfo, productType) => {
  const list = asArray(vipInfo && vipInfo.busi_vip);
  const hit = list.find(
    (item) => item && item.product_type === productType && Number(item.is_vip) === 1,
  );
  return hit || null;
};

const toTimestamp = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatVipExpire = (vip) => {
  const ms = toTimestamp(vip && vip.vip_end_time);
  return ms ? toBeijingDate(ms) : "";
};

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "尚未执行";

/** 日期比较，兼容 "2026-09-25" 与 20260925 两种格式 */
const isSameDay = (value, today) => {
  if (value === undefined || value === null) return false;
  return String(value).replace(/\D/g, "") === String(today).replace(/\D/g, "");
};

/** 把接口错误码 / 错误信息转成可读文案 */
const describeError = (res, fallback) => {
  if (!res || typeof res !== "object") return fallback;
  const data = pickData(res) || {};
  const code = Number(res.error_code ?? res.errorCode ?? data.error_code ?? data.errorCode ?? 0);
  if (code === 297002) return "今日已领取过";
  const message = res.error_msg ?? res.msg ?? data.error_msg ?? data.msg;
  if (message) return String(message);
  if (code) return `错误码 ${code}`;
  return fallback;
};

export function activate(ctx) {
  const { defineAsyncComponent, defineComponent, h, reactive, computed } = ctx.vue;
  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);
  const Select = defineAsyncComponent(ctx.ui.components.Select);

  const state = reactive({
    auto: DEFAULTS.auto,
    intervalHours: DEFAULTS.intervalHours,
    notify: DEFAULTS.notify,
    loggedIn: false,
    probeReason: "", // 登录态探测失败的原始原因，便于排查
    running: false,
    today: "",
    claimedToday: false, // 今日是否已领取（来自领取记录）
    tvip: false, // 畅听会员当前是否生效
    svip: false, // 概念会员当前是否生效
    tvipExpire: "",
    svipExpire: "",
    lastRunAt: 0,
    lastMessage: "",
    nextCheckAt: 0,
    doneDate: "", // 今日已领取完成（领取+升级）的日期，命中后自动检查完全休眠
    upgradeFailDate: "",
    upgradeFails: 0,
    lastAutoAttemptAt: 0,
  });

  const statusText = computed(() => {
    if (!state.loggedIn) return "未登录（请先登录 EchoMusic）";
    if (!state.today) return "获取中…";
    return `畅听会员 ${state.claimedToday ? "已领取" : "未领取"} / 概念会员 ${
      state.svip ? "已升级" : "未升级"
    }`;
  });

  const activeText = computed(() => {
    if (!state.loggedIn) return "";
    const parts = [];
    parts.push(state.tvip ? `畅听会员至 ${state.tvipExpire || "—"}` : "畅听会员未生效");
    parts.push(state.svip ? `概念会员至 ${state.svipExpire || "—"}` : "概念会员未生效");
    return parts.join(" · ");
  });

  let timer = null;

  // ---------- 登录态探测 ----------

  /**
   * 插件 activate 可能早于 API 服务 / 登录态就绪，也可能拿到 503，
   * 这里做宽容判定：业务 status===1 即视为已登录，同时记录原始失败原因。
   */
  const probeLogin = async () => {
    try {
      const res = await ctx.kugou.user.getUserDetail();
      const status = Number(res && res.status);
      if (status === 1) return { loggedIn: true, reason: "" };
      return { loggedIn: false, reason: describeError(res, `status=${status || "无"}`) };
    } catch (error) {
      return { loggedIn: false, reason: String((error && error.message) || error) };
    }
  };

  // ---------- 业务接口 ----------

  const getServerToday = async () => {
    try {
      const res = await ctx.kugou.user.getServerNow();
      const data = pickData(res) || {};
      const candidates = [
        data.now,
        data.time,
        data.timestamp,
        data.server_time,
        data.serverTime,
        data.data && data.data.now,
      ];
      for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value) && value > 0) {
          return toBeijingDate(value > 1e12 ? value : value * 1000);
        }
      }
    } catch (error) {
      // 忽略，走本地时间兜底
    }
    return localBeijingDate();
  };

  /** 今日是否已在领取记录中（接口异常时返回 null，表示未知） */
  const isClaimedToday = async (today) => {
    try {
      const res = await ctx.kugou.user.getVipMonthRecord();
      const data = pickData(res);
      const list = asArray(data && data.list !== undefined ? data.list : data);
      return list.some((item) => isSameDay(item && item.day, today));
    } catch (error) {
      return null;
    }
  };

  /** 读取当前生效的会员：优先 /user/vip/detail，回退 /user/detail 的 extendsInfo.vip */
  const refreshVipInfo = async () => {
    try {
      let vipInfo = null;

      try {
        const vipRes = await ctx.kugou.user.getUserVipDetail();
        if (vipRes && vipRes.status === 1) {
          const vipData = pickData(vipRes);
          if (vipData && (vipData.busi_vip || vipData.vip)) vipInfo = vipData.vip || vipData;
        }
      } catch (error) {
        // 回退到 user detail
      }

      if (!vipInfo) {
        const res = await ctx.kugou.user.getUserDetail();
        const data = pickData(res) || {};
        vipInfo = data.vip || (data.extendsInfo && data.extendsInfo.vip) || {};
      }

      const tvip = findActiveVip(vipInfo, "tvip");
      const svip = findActiveVip(vipInfo, "svip");
      state.tvip = Boolean(tvip);
      state.svip = Boolean(svip);
      state.tvipExpire = formatVipExpire(tvip);
      state.svipExpire = formatVipExpire(svip);
    } catch (error) {
      // 刷新失败不阻塞领取
    }
  };

  const refreshAll = async () => {
    const probe = await probeLogin();
    state.loggedIn = probe.loggedIn;
    state.probeReason = probe.reason;
    if (!probe.loggedIn) {
      state.today = "";
      state.claimedToday = false;
      state.tvip = false;
      state.svip = false;
      state.tvipExpire = "";
      state.svipExpire = "";
      return false;
    }
    state.today = await getServerToday();
    const claimed = await isClaimedToday(state.today);
    state.claimedToday = claimed === null ? state.claimedToday : claimed;
    await refreshVipInfo();
    return true;
  };

  // ---------- 领取流程 ----------

  const runClaim = async (options) => {
    const manual = Boolean(options && options.manual);
    if (state.running) return null;
    state.running = true;

    const result = { tvip: false, svip: false, already: false, error: "" };
    try {
      const probe = await probeLogin();
      state.loggedIn = probe.loggedIn;
      state.probeReason = probe.reason;
      if (!probe.loggedIn) {
        result.error = probe.reason
          ? `未登录或登录已过期（${probe.reason}）`
          : "未登录或登录已过期";
        return result;
      }

      const today = await getServerToday();
      state.today = today;

      // 已领过则直接走升级，避免重复请求；记录接口异常时照样尝试领取
      const claimed = await isClaimedToday(today);
      if (claimed === true) {
        result.already = true;
        result.tvip = true;
      } else {
        const claimRes = await ctx.kugou.user.claimDayVip(today);
        result.tvip = Boolean(claimRes && claimRes.status === 1);
        if (!result.tvip) {
          result.error = describeError(claimRes, "领取畅听会员失败");
        }
      }

      // 畅听会员到账后尝试升级概念会员
      if (result.tvip) {
        try {
          const upgradeRes = await ctx.kugou.user.upgradeDayVip();
          result.svip =
            Boolean(upgradeRes && upgradeRes.status === 1) ||
            Number(upgradeRes && upgradeRes.error_code) === 297002;
          if (!result.svip && !result.error) {
            result.error = describeError(upgradeRes, "升级概念会员失败");
          }
        } catch (error) {
          if (!result.error) result.error = String((error && error.message) || error);
        }
      }

      state.claimedToday = result.already || result.tvip || state.claimedToday;
      await refreshVipInfo();
    } catch (error) {
      result.error = String((error && error.message) || error);
    } finally {
      state.running = false;
      state.lastRunAt = Date.now();

      // 当日升级结果记账：连续失败达到上限后当天不再重试
      if (result.tvip) {
        const today = state.today || localBeijingDate();
        if (state.upgradeFailDate !== today) {
          state.upgradeFailDate = today;
          state.upgradeFails = 0;
        }
        if (result.svip) state.upgradeFails = 0;
        else state.upgradeFails += 1;
      }

      // 领取 + 升级都完成（或升级已确认无资格），今日休眠，不再发任何请求
      if ((result.already || result.tvip) && (result.svip || state.upgradeFails >= MAX_UPGRADE_FAILS)) {
        state.doneDate = state.today || localBeijingDate();
      }

      state.lastMessage = result.already
        ? `今日（${state.today || "—"}）已领取过`
        : result.error
          ? result.error
          : `领取成功：畅听会员 ${result.tvip ? "✓" : "✗"} / 概念会员 ${result.svip ? "✓" : "✗"}`;

      const failed = Boolean(result.error) && !result.tvip && !result.svip;
      if (manual) {
        if (failed) ctx.toast.warning(`每日领 VIP：${result.error}`);
        else ctx.toast.success(`每日领 VIP：${state.lastMessage}`);
      } else if (state.notify && !result.already && (result.tvip || result.svip)) {
        // 仅在本次真正领到时提示，避免每小时重复弹“已领取过”
        ctx.toast.success(`每日领 VIP：${state.lastMessage}`);
      }
    }

    return result;
  };

  // ---------- 定时器 ----------

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
    state.nextCheckAt = 0;
  };

  const startTimer = () => {
    stopTimer();
    if (!state.auto) return;
    const hours = Math.min(24, Math.max(0.5, Number(state.intervalHours) || 1));
    const intervalMs = hours * 3600 * 1000;
    state.nextCheckAt = Date.now() + intervalMs;
    timer = setInterval(() => {
      void autoRun();
    }, intervalMs);
  };

  // ---------- 自动领取（带休眠判断） ----------

  /** 今日是否已完成领取（本地日期判断，不发请求） */
  const isDoneToday = () => state.doneDate === localBeijingDate();

  /**
   * 定时器 / 播放事件共用的自动领取入口：
   * - 今日已完成 → 直接返回，零请求
   * - 距上次自动尝试不足 AUTO_MIN_GAP → 跳过，避免连续切歌反复打接口
   */
  const autoRun = async () => {
    if (!state.auto || state.running) return;
    if (isDoneToday()) return;
    const now = Date.now();
    if (now - state.lastAutoAttemptAt < AUTO_MIN_GAP) return;
    state.lastAutoAttemptAt = now;
    await runClaim({ manual: false });
  };

  // ---------- 设置持久化 ----------

  const persist = async () => {
    try {
      await ctx.storage.set(SETTINGS_KEY, {
        auto: state.auto,
        intervalHours: state.intervalHours,
        notify: state.notify,
      });
    } catch (error) {
      // 忽略存储失败
    }
  };

  const onAutoChange = async (value) => {
    state.auto = Boolean(value);
    await persist();
    startTimer();
    // 用户主动开启：忽略冷却间隔立即尝试一次（今日已完成的仍会休眠）
    state.lastAutoAttemptAt = 0;
    if (state.auto) void autoRun();
  };

  const onIntervalChange = async (value) => {
    state.intervalHours = Number(value) || DEFAULTS.intervalHours;
    await persist();
    startTimer();
  };

  const onNotifyChange = async (value) => {
    state.notify = Boolean(value);
    await persist();
  };

  // ---------- 设置面板 ----------

  const SettingsPanel = defineComponent({
    setup() {
      return () =>
        h("div", { class: "daily-vip-panel" }, [
          h("div", { class: "daily-vip-row" }, [
            h("span", { class: "daily-vip-label" }, "自动领取"),
            h(Switch, {
              modelValue: state.auto,
              "onUpdate:modelValue": (value) => void onAutoChange(value),
            }),
          ]),
          h("div", { class: "daily-vip-row" }, [
            h("span", { class: "daily-vip-label" }, "检查间隔"),
            h(Select, {
              modelValue: state.intervalHours,
              options: [
                { label: "每 1 小时", value: 1 },
                { label: "每 2 小时", value: 2 },
                { label: "每 6 小时", value: 6 },
                { label: "每 12 小时", value: 12 },
              ],
              "onUpdate:modelValue": (value) => void onIntervalChange(value),
            }),
          ]),
          h("div", { class: "daily-vip-row" }, [
            h("span", { class: "daily-vip-label" }, "领取成功提示"),
            h(Switch, {
              modelValue: state.notify,
              "onUpdate:modelValue": (value) => void onNotifyChange(value),
            }),
          ]),
          h("div", { class: "daily-vip-status" }, [
            h("div", { class: "daily-vip-status-line" }, `今日状态：${statusText.value}`),
            state.loggedIn && activeText.value
              ? h("div", { class: "daily-vip-status-line" }, `生效中：${activeText.value}`)
              : null,
            h(
              "div",
              { class: "daily-vip-status-line" },
              state.lastRunAt
                ? `上次执行：${formatTime(state.lastRunAt)}（${state.lastMessage}）`
                : "上次执行：尚未执行",
            ),
            state.auto && state.nextCheckAt && !isDoneToday()
              ? h(
                  "div",
                  { class: "daily-vip-status-line" },
                  `下次检查：${formatTime(state.nextCheckAt)}`,
                )
              : null,
            state.auto && isDoneToday()
              ? h("div", { class: "daily-vip-status-line" }, "今日已领取完成，自动检查已休眠（零请求）")
              : null,
            !state.loggedIn && state.probeReason
              ? h("div", { class: "daily-vip-status-line" }, `探测详情：${state.probeReason}`)
              : null,
          ]),
          h("div", { class: "daily-vip-actions" }, [
            h(
              Button,
              {
                size: "xs",
                disabled: state.running,
                onClick: () => void runClaim({ manual: true }),
              },
              { default: () => (state.running ? "领取中…" : "立即领取") },
            ),
            h(
              Button,
              {
                variant: "outline",
                size: "xs",
                disabled: state.running,
                onClick: () => void refreshAll(),
              },
              { default: () => "刷新状态" },
            ),
          ]),
        ]);
    },
  });

  ctx.ui.settings.define({
    title: "每日领 VIP",
    component: SettingsPanel,
  });

  // 播放触发：开软件后没赶上启动领取（如启动时接口未就绪）、或跨天首次播放时，立即补领
  if (ctx.events && typeof ctx.events.onTrackChange === "function") {
    ctx.events.onTrackChange(() => {
      void autoRun();
    });
  }

  // ---------- 启动 ----------

  const loadSettings = async () => {
    try {
      const saved = await ctx.storage.get(SETTINGS_KEY);
      if (saved && typeof saved === "object") {
        if (typeof saved.auto === "boolean") state.auto = saved.auto;
        if (Number(saved.intervalHours) > 0) state.intervalHours = Number(saved.intervalHours);
        if (typeof saved.notify === "boolean") state.notify = saved.notify;
      }
    } catch (error) {
      // 使用默认设置
    }
  };

  const boot = async () => {
    await loadSettings();

    // 激活时机可能早于 API 服务 / 登录态就绪，重试探测而不是直接判未登录
    for (let attempt = 0; attempt < BOOT_RETRY; attempt += 1) {
      if (await refreshAll()) break;
      await sleep(BOOT_RETRY_DELAY);
    }

    startTimer();
    if (state.auto && state.loggedIn) void runClaim({ manual: false });
  };

  void boot();

  ctx.dispose(() => {
    stopTimer();
  });
}
