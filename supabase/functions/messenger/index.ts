// Facebook Messenger webhook — Mistral + tools + long memory + reminders.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { initWasm as initResvg, Resvg } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const FB_API = "https://graph.facebook.com/v19.0/me/messages";
// Mistral Large 3: official model id from Mistral docs, multimodal + function calling.
const TEXT_MODEL = "mistral-large-2512";
const VISION_MODEL = "mistral-large-2512";
const HISTORY_LIMIT = 60; // last 60 messages always sent
const MISTRAL_AGENT_URL = "https://api.mistral.ai/v1/agents";
const MISTRAL_CONVERSATIONS_URL = "https://api.mistral.ai/v1/conversations";

const ASK_PROMPT_AR =
  "وصلتني الصورة 📷 ماذا تريد أن تعرف عنها بالضبط؟";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const IMAGE_MARK = "[IMG]";

function getAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Mistral API key: prefer value stored in `app_config` (editable from admin UI),
// fall back to the MISTRAL_API_KEY env secret. Cached for 30s per instance.
let _mistralKeyCache: { value: string | null; expiresAt: number } | null = null;
async function getMistralKey(): Promise<string | null> {
  if (_mistralKeyCache && _mistralKeyCache.expiresAt > Date.now()) return _mistralKeyCache.value;
  let value: string | null = null;
  try {
    const admin = getAdmin();
    const { data } = await admin.from("app_config").select("mistral_api_key").limit(1).maybeSingle();
    const dbKey = (data as any)?.mistral_api_key;
    if (dbKey && typeof dbKey === "string" && dbKey.trim()) value = dbKey.trim();
  } catch (_e) { /* ignore, fall back to env */ }
  if (!value) value = Deno.env.get("MISTRAL_API_KEY") ?? null;
  _mistralKeyCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

// Ask Mistral to judge whether the message contains insults / profanity /
// hate speech / harassment / sexual harassment aimed at the bot or others.
// Returns `null` for safe content, `{ reason }` when the message should trigger a block.
async function moderateMessage(text: string): Promise<{ reason: string } | null> {
  const key = await getMistralKey();
  if (!key) return null; // fail-open if key missing, to avoid false blocks
  try {
    const res = await fetch(MISTRAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "mistral-small-latest",
        temperature: 0,
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'أنت مصنّف محتوى صارم. اقرأ رسالة المستخدم واحكم فقط: هل تحوي شتائم أو سبّاً أو إهانة أو تحرشاً أو خطاباً عدائياً/عنصرياً/طائفياً/جنسياً فاحشاً موجّهاً للبوت أو لأي شخص؟ الشكاوى العادية والغضب المهذّب والانتقاد ليست إهانة. أعد JSON فقط بالشكل: {"unsafe": true|false, "reason": "insult|profanity|harassment|hate|sexual|other"}. لا شيء آخر.',
          },
          { role: "user", content: text.slice(0, 1000) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    let parsed: any = null;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    if (parsed?.unsafe === true) return { reason: String(parsed.reason || "inappropriate_language") };
    return null;
  } catch (e) {
    console.error("[messenger] moderation error", e);
    return null;
  }
}

// Fetch Messenger user profile from Graph API and upsert into facebook_profiles.
// Skips when a fresh (<7 days) profile is already cached.
async function ensureFbProfile(admin: any, senderId: string, pageId: string | null) {
  try {
    const { data: existing } = await admin
      .from("facebook_profiles")
      .select("facebook_user_id, updated_at")
      .eq("facebook_user_id", senderId)
      .maybeSingle();
    if (existing?.updated_at) {
      const ageMs = Date.now() - new Date(existing.updated_at).getTime();
      if (ageMs < 7 * 24 * 3600_000) return;
    }
    const token = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
    if (!token) return;
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(senderId)}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[messenger] fb profile fetch failed", res.status, await res.text().catch(() => ""));
      return;
    }
    const p = await res.json();
    const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || null;
    await admin.from("facebook_profiles").upsert({
      facebook_user_id: senderId,
      first_name: p.first_name ?? null,
      last_name: p.last_name ?? null,
      name,
      profile_pic: p.profile_pic ?? null,
      page_id: pageId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "facebook_user_id" });
  } catch (e) {
    console.error("[messenger] ensureFbProfile error", e);
  }
}

// === Tool definitions exposed to Mistral ===
const tools = [
  {
    type: "function",
    function: {
      name: "save_memory",
      description:
        "احفظ معلومة دائمة عن المستخدم لن تُنسى أبداً (الاسم، التفضيلات، الوظيفة، اللغة، الأهداف...). استخدمها كلما عرفت شيئاً جديداً.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "مفتاح قصير بالإنجليزية مثل: name, language, job, preference_color" },
          value: { type: "string", description: "القيمة الحالية" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description:
        "جدوِل رسالة تذكير للمستخدم بعد عدد من الدقائق. مثال: ذكّرني بعد دقيقة بشرب الماء.",
      parameters: {
        type: "object",
        properties: {
          minutes_from_now: { type: "number", description: "بعد كم دقيقة من الآن" },
          message: { type: "string", description: "نص التذكير الذي سيُرسل للمستخدم" },
        },
        required: ["minutes_from_now", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "اعرض التذكيرات القادمة للمستخدم.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "احذف تذكيراً قادماً عن طريق معرّفه.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description:
        "احسب أي تعبير رياضي (جمع، طرح، ضرب، قسمة، أقواس، نسبة مئوية، أس). استخدمها لأي عملية حسابية بدل التخمين.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "تعبير رياضي مثل: (15+27)*3/2  أو  150*0.18" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "convert_currency",
      description: "حوّل مبلغ من عملة إلى أخرى بأسعار حقيقية محدّثة. مثال: 100 USD إلى EUR.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          from: { type: "string", description: "رمز العملة المصدر مثل USD, EUR, MAD, SAR, AED" },
          to: { type: "string", description: "رمز العملة الهدف" },
        },
        required: ["amount", "from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "اجلب حالة الطقس الحالية ودرجة الحرارة لمدينة معينة.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "اسم المدينة بأي لغة، مثلاً: الرباط، Casablanca، Paris" },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "translate",
      description: "ترجم نصاً من لغة إلى أخرى ترجمة دقيقة وطبيعية.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          target_language: { type: "string", description: "لغة الهدف مثل: العربية، English، Français، Español" },
        },
        required: ["text", "target_language"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_voice_note",
      description:
        "حوّل نصاً قصيراً إلى ملاحظة صوتية وأرسلها للمستخدم على ماسنجر. استخدمها فقط عندما يطلب المستخدم صراحة سماع الرد كصوت.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "النص الذي سيُنطق (يفضّل أقل من 500 حرف)" },
          voice: {
            type: "string",
            description: "الصوت: alloy (افتراضي محايد)، nova (أنثوي دافئ)، echo (ذكوري)، shimmer (أنثوي مرح)، onyx (ذكوري عميق)",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "أنشئ/تخيّل صورة من وصف نصي وأرسلها للمستخدم على ماسنجر. استخدمها كلما طلب المستخدم صورة أو رسمة أو تصميماً أو تخيّل مشهد. مهم جداً: إذا طلب المستخدم كتابة نص عربي داخل الصورة، لا تضع النص العربي في حقل prompt أبداً (النموذج يشوّهه)، بل مرّر الوصف البصري بالإنجليزية في prompt واذكر فيه 'leave a clean empty banner area at the bottom for text', ثم ضع النص العربي المطلوب حرفياً في حقل arabic_text وسيُرسم فوق الصورة بخط عربي حقيقي.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "وصف بصري للصورة (يفضّل الإنجليزية للجودة). لا تضع نصاً عربياً هنا.",
          },
          arabic_text: {
            type: "string",
            description: "اختياري: النص العربي الذي يجب أن يظهر داخل الصورة حرفياً. يُرسم بخط عربي حقيقي فوق الصورة بعد توليدها.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "ابحث بعمق في الويب بالوقت الفعلي عبر أداة Mistral الرسمية web_search/web_search_premium عن الأخبار، الرياضة، الأسعار، الأحداث الجارية، النتائج، وأي معلومة حديثة أو غير مؤكدة. استخدمها دائماً قبل الإجابة عن أي شيء قد يكون تغيّر.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "استعلام البحث. يفضّل بالإنجليزية للنتائج الأشمل، لكن العربية تعمل." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_url",
      description: "افتح صفحة ويب بعنوان URL محدد واقرأ محتواها كنص. استخدمها لقراءة مقال/صفحة يذكرها المستخدم أو للتوسع في نتيجة web_search.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "رابط الصفحة الكامل يبدأ بـ http/https" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_novel",
      description:
        "ابدأ رواية تفاعلية جديدة للمستخدم. استخدمها حين يطلب رواية/قصة طويلة. خزّن العنوان والنوع والفكرة والبطل والأسلوب. أعِد id الجلسة لتستخدمه لاحقاً.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "عنوان الرواية" },
          genre: { type: "string", description: "النوع: رومانسي، خيال علمي، رعب، تاريخي، مغامرات، فانتازيا..." },
          premise: { type: "string", description: "الفكرة الأساسية للرواية في 2-3 أسطر" },
          protagonist: { type: "string", description: "وصف البطل/الأبطال" },
          style: { type: "string", description: "الأسلوب: فصحى، عامية، شاعري، واقعي، مظلم..." },
        },
        required: ["title", "premise"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_novel_chapter",
      description:
        "احفظ فصلاً كتبته للتو من الرواية في قاعدة البيانات. استدعِها بعد كل فصل تنشره للمستخدم حتى لا تُنسى الأحداث وتستمر القصة بسلاسة.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "id جلسة الرواية" },
          title: { type: "string", description: "عنوان الفصل (اختياري)" },
          content: { type: "string", description: "نص الفصل كاملاً" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_novels",
      description: "اعرض كل روايات المستخدم النشطة والمكتملة مع رقم آخر فصل.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_novel",
      description:
        "أكمل رواية سابقة. تعيد لك تفاصيل الرواية + آخر 2 فصلين كاملين لتلتقط الخيط وتكمل بسلاسة.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_novel",
      description: "أنهِ رواية (اجعل حالتها completed) عند انتهاء أحداثها أو طلب المستخدم.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
  },
];

async function executeTool(name: string, args: any, senderId: string, admin: any): Promise<string> {
  try {
    if (name === "save_memory") {
      await admin.from("user_memory").upsert(
        { facebook_user_id: senderId, key: String(args.key), value: String(args.value) },
        { onConflict: "facebook_user_id,key" },
      );
      return JSON.stringify({ ok: true, saved: { [args.key]: args.value } });
    }
    if (name === "set_reminder") {
      const mins = Number(args.minutes_from_now);
      const remindAt = new Date(Date.now() + mins * 60_000).toISOString();
      const { data, error } = await admin
        .from("reminders")
        .insert({ facebook_user_id: senderId, message: String(args.message), remind_at: remindAt })
        .select("id, remind_at").single();
      if (error) return JSON.stringify({ ok: false, error: error.message });
      return JSON.stringify({ ok: true, id: data.id, remind_at: data.remind_at });
    }
    if (name === "list_reminders") {
      const { data } = await admin
        .from("reminders")
        .select("id, message, remind_at, sent")
        .eq("facebook_user_id", senderId)
        .eq("sent", false)
        .order("remind_at", { ascending: true });
      return JSON.stringify({ ok: true, reminders: data ?? [] });
    }
    if (name === "cancel_reminder") {
      const { error } = await admin
        .from("reminders").delete()
        .eq("id", String(args.id))
        .eq("facebook_user_id", senderId);
      if (error) return JSON.stringify({ ok: false, error: error.message });
      return JSON.stringify({ ok: true });
    }
    if (name === "calculator") {
      const result = safeCalc(String(args.expression ?? ""));
      if (result === null) return JSON.stringify({ ok: false, error: "expression_invalid" });
      return JSON.stringify({ ok: true, expression: args.expression, result });
    }
    if (name === "convert_currency") {
      return await convertCurrency(Number(args.amount), String(args.from), String(args.to));
    }
    if (name === "get_weather") {
      return await getWeather(String(args.city));
    }
    if (name === "translate") {
      return await translateText(String(args.text), String(args.target_language));
    }
    if (name === "send_voice_note") {
      return await sendVoiceNote(senderId, String(args.text), String(args.voice ?? "alloy"), admin);
    }
    if (name === "generate_image") {
      return await generateImage(senderId, String(args.prompt ?? ""), admin, args.arabic_text ? String(args.arabic_text) : "");
    }
    if (name === "web_search") {
      return await webSearch(String(args.query ?? ""));
    }
    if (name === "read_url") {
      return await readUrl(String(args.url ?? ""));
    }
    if (name === "start_novel") {
      const { data, error } = await admin.from("novel_sessions").insert({
        facebook_user_id: senderId,
        title: String(args.title),
        genre: args.genre ? String(args.genre) : null,
        premise: args.premise ? String(args.premise) : null,
        protagonist: args.protagonist ? String(args.protagonist) : null,
        style: args.style ? String(args.style) : null,
      }).select("id, title").single();
      if (error) return JSON.stringify({ ok: false, error: error.message });
      return JSON.stringify({ ok: true, session_id: data.id, title: data.title });
    }
    if (name === "save_novel_chapter") {
      const sid = String(args.session_id);
      const { data: sess } = await admin.from("novel_sessions")
        .select("id, current_chapter, facebook_user_id").eq("id", sid).maybeSingle();
      if (!sess || sess.facebook_user_id !== senderId) return JSON.stringify({ ok: false, error: "session_not_found" });
      const next = (sess.current_chapter ?? 0) + 1;
      const { error } = await admin.from("novel_chapters").insert({
        session_id: sid, chapter_number: next,
        title: args.title ? String(args.title) : null,
        content: String(args.content),
      });
      if (error) return JSON.stringify({ ok: false, error: error.message });
      await admin.from("novel_sessions").update({ current_chapter: next, updated_at: new Date().toISOString() }).eq("id", sid);
      return JSON.stringify({ ok: true, chapter_number: next });
    }
    if (name === "list_my_novels") {
      const { data } = await admin.from("novel_sessions")
        .select("id, title, genre, current_chapter, status, updated_at")
        .eq("facebook_user_id", senderId)
        .order("updated_at", { ascending: false }).limit(20);
      return JSON.stringify({ ok: true, novels: data ?? [] });
    }
    if (name === "resume_novel") {
      const sid = String(args.session_id);
      const { data: sess } = await admin.from("novel_sessions")
        .select("*").eq("id", sid).maybeSingle();
      if (!sess || sess.facebook_user_id !== senderId) return JSON.stringify({ ok: false, error: "session_not_found" });
      const { data: chaps } = await admin.from("novel_chapters")
        .select("chapter_number, title, content")
        .eq("session_id", sid)
        .order("chapter_number", { ascending: false }).limit(2);
      return JSON.stringify({ ok: true, session: sess, last_chapters: (chaps ?? []).reverse() });
    }
    if (name === "end_novel") {
      const sid = String(args.session_id);
      const { error } = await admin.from("novel_sessions")
        .update({ status: "completed" }).eq("id", sid).eq("facebook_user_id", senderId);
      if (error) return JSON.stringify({ ok: false, error: error.message });
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ ok: false, error: "unknown_tool" });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}

// ============ TOOL IMPLEMENTATIONS ============

function safeCalc(expr: string): number | null {
  // Allow only digits, operators, parens, dot, spaces, %, ** for power
  const cleaned = expr.replace(/\s+/g, "");
  if (!/^[-+*/%().\d]+(\*\*[-+*/%().\d]+)*$/.test(cleaned) && !/^[-+*/%().\d**]+$/.test(cleaned)) {
    // Second simpler check
    if (!/^[0-9+\-*/().%\s]+$/.test(expr)) return null;
  }
  try {
    // eslint-disable-next-line no-new-func
    const val = Function(`"use strict"; return (${expr});`)();
    if (typeof val !== "number" || !isFinite(val)) return null;
    return Math.round(val * 1e10) / 1e10;
  } catch {
    return null;
  }
}

async function convertCurrency(amount: number, from: string, to: string): Promise<string> {
  if (!isFinite(amount) || !from || !to) {
    return JSON.stringify({ ok: false, error: "invalid_params" });
  }
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  try {
    // open.er-api.com — free, no key
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`);
    if (!res.ok) return JSON.stringify({ ok: false, error: "rates_unavailable" });
    const data = await res.json();
    const rate = data?.rates?.[t];
    if (typeof rate !== "number") return JSON.stringify({ ok: false, error: "currency_not_found" });
    const converted = Math.round(amount * rate * 100) / 100;
    return JSON.stringify({
      ok: true,
      amount,
      from: f,
      to: t,
      rate,
      result: converted,
      updated: data.time_last_update_utc,
    });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}

async function getWeather(city: string): Promise<string> {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ar`,
    );
    const geoData = await geo.json();
    const loc = geoData?.results?.[0];
    if (!loc) return JSON.stringify({ ok: false, error: "city_not_found" });

    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`,
    );
    const wData = await w.json();
    const c = wData?.current;
    if (!c) return JSON.stringify({ ok: false, error: "weather_unavailable" });

    return JSON.stringify({
      ok: true,
      city: loc.name,
      country: loc.country,
      temperature_c: c.temperature_2m,
      humidity: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      weather_code: c.weather_code,
      description: weatherCodeText(c.weather_code),
      time: c.time,
    });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}

function weatherCodeText(code: number): string {
  const map: Record<number, string> = {
    0: "صافٍ", 1: "صافٍ غالباً", 2: "غائم جزئياً", 3: "غائم",
    45: "ضباب", 48: "ضباب متجمد",
    51: "رذاذ خفيف", 53: "رذاذ", 55: "رذاذ كثيف",
    61: "مطر خفيف", 63: "مطر", 65: "مطر غزير",
    71: "ثلج خفيف", 73: "ثلج", 75: "ثلج كثيف",
    77: "حبيبات ثلج",
    80: "زخات مطر خفيفة", 81: "زخات مطر", 82: "زخات مطر عنيفة",
    85: "زخات ثلج", 86: "زخات ثلج كثيفة",
    95: "عاصفة رعدية", 96: "عاصفة رعدية مع بَرَد خفيف", 99: "عاصفة رعدية مع بَرَد كثيف",
  };
  return map[code] ?? "غير معروف";
}

async function translateText(text: string, target: string): Promise<string> {
  const key = await getMistralKey();
  if (!key) return JSON.stringify({ ok: false, error: "no_translator" });
  try {
    const res = await fetch(MISTRAL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: `You are a professional translator. Translate the user's text to ${target}. Return ONLY the translated text, no explanations, no quotes.` },
          { role: "user", content: text },
        ],
        max_tokens: 1500,
      }),
    });
    if (!res.ok) return JSON.stringify({ ok: false, error: "translation_failed" });
    const j = await res.json();
    const out = j?.choices?.[0]?.message?.content?.trim() ?? "";
    return JSON.stringify({ ok: true, translation: out, target_language: target });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}

async function sendVoiceNote(senderId: string, text: string, voice: string, admin: any): Promise<string> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const pageToken = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  if (!lovableKey) { console.error("[messenger] TTS: LOVABLE_API_KEY missing"); return JSON.stringify({ ok: false, error: "tts_unavailable" }); }
  if (!pageToken) { console.error("[messenger] TTS: FB_PAGE_ACCESS_TOKEN missing"); return JSON.stringify({ ok: false, error: "fb_token_missing" }); }

  const trimmed = text.slice(0, 1500);
  const validVoices = ["alloy", "echo", "shimmer", "nova", "onyx", "fable"];
  const v = validVoices.includes(voice) ? voice : "alloy";
  console.log("[messenger] TTS start", { senderId, chars: trimmed.length, voice: v });

  try {
    // Generate MP3 (non-streaming for simplicity)
    const ttsRes = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: trimmed,
        voice: v,
        response_format: "mp3",
      }),
    });
    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      console.error("[messenger] TTS failed", ttsRes.status, errText);
      return JSON.stringify({ ok: false, error: `tts_${ttsRes.status}` });
    }
    const audioBuf = new Uint8Array(await ttsRes.arrayBuffer());

    // Upload to private bucket
    const path = `voice/${senderId}/${Date.now()}.mp3`;
    const { error: upErr } = await admin.storage.from("bot-media").upload(path, audioBuf, {
      contentType: "audio/mpeg",
      upsert: false,
    });
    if (upErr) {
      console.error("[messenger] storage upload failed", upErr);
      return JSON.stringify({ ok: false, error: "upload_failed" });
    }

    // Signed URL valid 1 hour — plenty of time for Facebook to fetch & cache
    const { data: signed, error: sErr } = await admin.storage
      .from("bot-media").createSignedUrl(path, 3600);
    if (sErr || !signed?.signedUrl) {
      return JSON.stringify({ ok: false, error: "sign_failed" });
    }

    // Send to Facebook as audio attachment
    const fbRes = await fetch(`${FB_API}?access_token=${encodeURIComponent(pageToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: senderId },
        messaging_type: "RESPONSE",
        message: {
          attachment: {
            type: "audio",
            payload: { url: signed.signedUrl, is_reusable: false },
          },
        },
      }),
    });
    if (!fbRes.ok) {
      const t = await fbRes.text();
      console.error("[messenger] FB audio send failed", fbRes.status, t);
      return JSON.stringify({ ok: false, error: "fb_send_failed", detail: t });
    }

    // Log it as a bot message
    await admin.from("messages").insert({
      facebook_user_id: senderId,
      sender_type: "bot",
      message_text: `🔊 [ملاحظة صوتية أُرسلت] ${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}`,
    });

    return JSON.stringify({ ok: true, sent: true, voice: v, length: trimmed.length });
  } catch (err: any) {
    console.error("[messenger] voice note error", err);
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}

// ============ IMAGE GENERATION (Mistral Agents API) ============

let cachedImageAgentId: string | null = null;
let resvgReady: Promise<void> | null = null;
let arabicFontBytes: Uint8Array | null = null;

async function ensureResvg() {
  if (!resvgReady) {
    resvgReady = (async () => {
      const wasmRes = await fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm");
      const buf = await wasmRes.arrayBuffer();
      await initResvg(buf);
    })();
  }
  await resvgReady;
}

async function ensureArabicFont(): Promise<Uint8Array> {
  if (arabicFontBytes) return arabicFontBytes;
  // Noto Naskh Arabic — supports full Arabic shaping/joining.
  const urls = [
    "https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoNaskhArabic/NotoNaskhArabic-Bold.ttf",
    "https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoNaskhArabic/NotoNaskhArabic-Regular.ttf",
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (r.ok) {
        arabicFontBytes = new Uint8Array(await r.arrayBuffer());
        return arabicFontBytes;
      }
    } catch (_) { /* try next */ }
  }
  throw new Error("arabic_font_fetch_failed");
}

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function overlayArabicText(pngBytes: Uint8Array, text: string): Promise<Uint8Array> {
  try {
    await ensureResvg();
    const font = await ensureArabicFont();
    const bg = await Image.decode(pngBytes);
    const W = bg.width;
    const H = bg.height;

    // Wrap long text into up to 3 lines by character count.
    const clean = text.trim().replace(/\s+/g, " ");
    const maxCharsPerLine = Math.max(18, Math.floor(W / 26));
    const words = clean.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > maxCharsPerLine && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = (cur ? cur + " " : "") + w;
      }
      if (lines.length >= 2) break;
    }
    if (cur) lines.push(cur);
    if (words.join(" ").length > lines.join(" ").length) {
      // Truncate remainder with ellipsis on last line.
      const used = lines.join(" ").length;
      const rest = clean.slice(used).trim();
      if (rest) lines[lines.length - 1] = (lines[lines.length - 1] + " " + rest).slice(0, maxCharsPerLine - 1) + "…";
    }

    const lineCount = lines.length;
    const bandH = Math.round(H * (0.14 + 0.07 * (lineCount - 1)));
    const fontSize = Math.round(bandH / (lineCount + 0.6));
    const lineHeight = Math.round(fontSize * 1.25);
    const startY = Math.round((bandH - lineHeight * lineCount) / 2 + fontSize);

    const tspans = lines.map((ln, i) =>
      `<tspan x="50%" y="${startY + i * lineHeight}">${escapeXml(ln)}</tspan>`
    ).join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${bandH}">
      <rect width="100%" height="100%" fill="rgb(255,255,255)" fill-opacity="0.9"/>
      <text text-anchor="middle" direction="rtl"
        font-family="Noto Naskh Arabic" font-weight="bold"
        font-size="${fontSize}" fill="rgb(15,15,15)">${tspans}</text>
    </svg>`;

    const resvg = new Resvg(svg, {
      font: { fontBuffers: [font], defaultFontFamily: "Noto Naskh Arabic", loadSystemFonts: false },
      textRendering: 2,
    });
    const pngData = resvg.render().asPng();

    const overlay = await Image.decode(pngData);
    bg.composite(overlay, 0, H - bandH);
    return await bg.encode();
  } catch (err) {
    console.error("[messenger] overlayArabicText failed", err);
    return pngBytes; // fall back to original
  }
}


async function ensureImageAgent(key: string): Promise<string | null> {
  if (cachedImageAgentId) return cachedImageAgentId;
  try {
    const res = await fetch("https://api.mistral.ai/v1/agents", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        name: "SolveBot GPT Image Agent",
        description: "Generates images on demand.",
        instructions: "Use the image_generation tool whenever the user asks for any image, drawing, illustration, or visual. Always call the tool; do not describe the image in text only.",
        tools: [{ type: "image_generation" }],
        completion_args: { temperature: 0.4, top_p: 0.95 },
      }),
    });
    if (!res.ok) {
      console.error("[messenger] agent create failed", res.status, await res.text());
      return null;
    }
    const j = await res.json();
    cachedImageAgentId = j?.id ?? null;
    return cachedImageAgentId;
  } catch (err) {
    console.error("[messenger] agent create error", err);
    return null;
  }
}

async function generateImage(senderId: string, prompt: string, admin: any, arabicText: string = ""): Promise<string> {
  const key = await getMistralKey();
  const pageToken = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  if (!key) return JSON.stringify({ ok: false, error: "no_image_provider" });
  if (!pageToken) return JSON.stringify({ ok: false, error: "fb_token_missing" });
  if (!prompt.trim()) return JSON.stringify({ ok: false, error: "empty_prompt" });

  // Strip any Arabic characters from prompt (Mistral image model mangles them);
  // real Arabic is drawn as an overlay via arabicText.
  const hasArabic = /[\u0600-\u06FF]/.test(prompt);
  let cleanPrompt = prompt;
  if (hasArabic) {
    cleanPrompt = prompt.replace(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]+/g, "").replace(/\s+/g, " ").trim();
    if (!cleanPrompt) cleanPrompt = "a clean visual scene";
  }
  if (arabicText.trim()) {
    cleanPrompt += ". Leave a clean empty horizontal banner area at the bottom of the image (about 20% of height) with a plain background — no text, no letters, no writing anywhere.";
  }

  const agentId = await ensureImageAgent(key);
  if (!agentId) return JSON.stringify({ ok: false, error: "agent_unavailable" });

  try {
    // Send "typing" hint (best effort)
    fetch(`${FB_API}?access_token=${encodeURIComponent(pageToken)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: senderId }, sender_action: "typing_on" }),
    }).catch(() => {});

    const convRes = await fetch("https://api.mistral.ai/v1/conversations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, inputs: cleanPrompt }),
    });
    if (!convRes.ok) {
      const t = await convRes.text();
      console.error("[messenger] conv failed", convRes.status, t);
      // Retry once with fresh agent in case cached id was stale
      if (convRes.status === 404 || convRes.status === 400) {
        cachedImageAgentId = null;
      }
      return JSON.stringify({ ok: false, error: `mistral_${convRes.status}` });
    }
    const conv = await convRes.json();

    // Find tool_file chunk
    let fileId: string | null = null;
    const outputs = conv?.outputs ?? [];
    for (const out of outputs) {
      const content = out?.content;
      if (Array.isArray(content)) {
        for (const chunk of content) {
          if (chunk?.type === "tool_file" && chunk?.file_id) { fileId = chunk.file_id; break; }
        }
      }
      if (fileId) break;
    }
    if (!fileId) {
      console.error("[messenger] no file_id in response", JSON.stringify(conv).slice(0, 500));
      return JSON.stringify({ ok: false, error: "no_image_produced" });
    }

    // Download image bytes
    const fileRes = await fetch(`https://api.mistral.ai/v1/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!fileRes.ok) {
      console.error("[messenger] file download failed", fileRes.status);
      return JSON.stringify({ ok: false, error: "download_failed" });
    }
    let imgBuf = new Uint8Array(await fileRes.arrayBuffer());

    // If the user requested Arabic text in the image, draw it as an overlay
    // using a real Arabic font (Mistral's image model can't render Arabic correctly).
    if (arabicText.trim()) {
      imgBuf = await overlayArabicText(imgBuf, arabicText.trim());
    }

    // Upload to bot-media
    const path = `images/${senderId}/${Date.now()}.png`;
    const { error: upErr } = await admin.storage.from("bot-media").upload(path, imgBuf, {
      contentType: "image/png", upsert: false,
    });
    if (upErr) {
      console.error("[messenger] storage upload failed", upErr);
      return JSON.stringify({ ok: false, error: "upload_failed" });
    }
    const { data: signed, error: sErr } = await admin.storage
      .from("bot-media").createSignedUrl(path, 3600);
    if (sErr || !signed?.signedUrl) return JSON.stringify({ ok: false, error: "sign_failed" });

    // Send image to Facebook
    const fbRes = await fetch(`${FB_API}?access_token=${encodeURIComponent(pageToken)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: senderId },
        messaging_type: "RESPONSE",
        message: {
          attachment: { type: "image", payload: { url: signed.signedUrl, is_reusable: false } },
        },
      }),
    });
    if (!fbRes.ok) {
      const t = await fbRes.text();
      console.error("[messenger] FB image send failed", fbRes.status, t);
      return JSON.stringify({ ok: false, error: "fb_send_failed", detail: t });
    }

    await admin.from("messages").insert({
      facebook_user_id: senderId,
      sender_type: "bot",
      message_text: `🖼️ [صورة أُرسلت] ${prompt.slice(0, 120)}`,
    });

    return JSON.stringify({ ok: true, sent: true, prompt });
  } catch (err: any) {
    console.error("[messenger] generate_image error", err);
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}

// ============ MAIN ============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("action") === "backfill_profiles") {
      const admin = getAdmin();
      const { data: uids } = await admin.from("messages")
        .select("facebook_user_id, page_id")
        .not("facebook_user_id", "is", null)
        .limit(5000);
      const seen = new Set<string>();
      const pageByUid = new Map<string, string | null>();
      for (const r of (uids ?? []) as any[]) {
        if (!seen.has(r.facebook_user_id)) {
          seen.add(r.facebook_user_id);
          pageByUid.set(r.facebook_user_id, r.page_id ?? null);
        }
      }
      let done = 0, skipped = 0;
      for (const uid of seen) {
        try {
          const before = await admin.from("facebook_profiles").select("facebook_user_id").eq("facebook_user_id", uid).maybeSingle();
          await ensureFbProfile(admin, uid, pageByUid.get(uid) ?? null);
          const after = await admin.from("facebook_profiles").select("name").eq("facebook_user_id", uid).maybeSingle();
          if (after.data?.name) done++; else if (before.data) skipped++;
        } catch (e) { console.error("[backfill]", uid, e); }
      }
      return new Response(JSON.stringify({ total: seen.size, populated: done, skipped }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const vt = Deno.env.get("FB_VERIFY_TOKEN");
    if (mode === "subscribe" && token && vt && token === vt) return new Response(challenge ?? "", { status: 200 });
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: any = null;
  try { body = await req.json(); } catch { return new Response("ok"); }
  if (!body || body.object !== "page") return new Response("ok");

  const events: { ev: any; pageId: string | null }[] = [];
  for (const entry of body.entry ?? []) {
    const pageId = entry?.id ? String(entry.id) : null;
    for (const m of entry.messaging ?? []) events.push({ ev: m, pageId });
  }

  const work = (async () => {
    for (const { ev, pageId } of events) {
      try { await handleEvent(ev, pageId); }
      catch (err) { console.error("[messenger] event failed", err); }
    }
  })();
  // @ts-ignore — EdgeRuntime is available in Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    work.catch((err) => console.error("[messenger] bg work failed", err));
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
});

async function pickPersona(admin: any, pageId: string | null, fallbackPrompt: string): Promise<string> {
  const { data: personas } = await admin.from("personas").select("*").eq("is_active", true);
  if (!personas?.length) return fallbackPrompt;
  const hour = new Date().getUTCHours();
  const matches = personas.filter((p: any) => {
    if (p.page_id && pageId && p.page_id !== pageId) return false;
    if (p.page_id && !pageId) return false;
    const fromH = p.active_from_hour, toH = p.active_to_hour;
    if (fromH != null && toH != null) {
      if (fromH <= toH) { if (hour < fromH || hour >= toH) return false; }
      else { if (hour < fromH && hour >= toH) return false; }
    }
    return true;
  });
  if (!matches.length) return fallbackPrompt;
  matches.sort((a: any, b: any) => {
    const aSpec = (a.page_id ? 2 : 0) + (a.active_from_hour != null ? 1 : 0);
    const bSpec = (b.page_id ? 2 : 0) + (b.active_from_hour != null ? 1 : 0);
    if (bSpec !== aSpec) return bSpec - aSpec;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
  return matches[0].system_prompt;
}

async function enrollInActiveDrips(admin: any, senderId: string) {
  const { count } = await admin.from("messages")
    .select("id", { count: "exact", head: true })
    .eq("facebook_user_id", senderId)
    .eq("sender_type", "user");
  if ((count ?? 0) > 1) return; // only on first user message
  const { data: campaigns } = await admin.from("drip_campaigns").select("id").eq("is_active", true);
  for (const c of campaigns ?? []) {
    await admin.from("drip_enrollments").insert({
      campaign_id: c.id, facebook_user_id: senderId,
    }).then(() => {}, () => {}); // ignore duplicates
  }
}

async function handleEvent(ev: any, pageId: string | null) {
  const senderId: string | undefined = ev?.sender?.id;
  if (!senderId) return;

  const admin = getAdmin();

  const mid: string | undefined = ev?.message?.mid;
  if (mid) {
    const { error: dupErr } = await admin
      .from("processed_messages")
      .insert({ mid });
    if (dupErr) {
      if ((dupErr as any).code === "23505" || /duplicate/i.test(dupErr.message ?? "")) {
        console.log("[messenger] duplicate mid skipped", mid);
        return;
      }
      console.error("[messenger] dedupe insert failed", dupErr);
    }
  }

  // === Postback handling (book reader buttons) ===
  const postbackPayload: string | undefined = ev?.postback?.payload;
  if (postbackPayload) {
    if (postbackPayload.startsWith("BOOK_READ:")) {
      const identifier = postbackPayload.slice("BOOK_READ:".length);
      await handleBookRead(admin, senderId, identifier, pageId);
      return;
    }
    if (postbackPayload === "BOOK_NEXT") {
      await handleBookNext(admin, senderId, pageId);
      return;
    }
    if (postbackPayload === "BOOK_STOP") {
      await admin.from("book_sessions").delete().eq("facebook_user_id", senderId);
      await sendAndLog(admin, senderId, "تم إيقاف القراءة ✅", pageId);
      return;
    }
  }

  // === Quick-reply handling (same payloads as postbacks; used on Messenger Lite) ===
  const quickReplyPayload: string | undefined = ev?.message?.quick_reply?.payload;
  if (quickReplyPayload) {
    if (quickReplyPayload.startsWith("BOOK_READ:")) {
      await handleBookRead(admin, senderId, quickReplyPayload.slice("BOOK_READ:".length), pageId);
      return;
    }
    if (quickReplyPayload === "BOOK_NEXT") { await handleBookNext(admin, senderId, pageId); return; }
    if (quickReplyPayload === "BOOK_STOP") {
      await admin.from("book_sessions").delete().eq("facebook_user_id", senderId);
      await sendAndLog(admin, senderId, "تم إيقاف القراءة ✅", pageId);
      return;
    }
  }

  let text: string = (ev?.message?.text ?? "").trim();

  const attachments: any[] = ev?.message?.attachments ?? [];
  const imageUrls: string[] = attachments
    .filter((a) => a?.type === "image" && a?.payload?.url)
    .map((a) => a.payload.url as string);
  const audioUrls: string[] = attachments
    .filter((a) => (a?.type === "audio" || a?.type === "video") && a?.payload?.url)
    .map((a) => a.payload.url as string);

  // Voice input: transcribe with Lovable AI STT, then treat as text and reply with voice.
  let isVoiceInput = false;
  if (audioUrls.length > 0) {
    const transcript = await transcribeAudio(audioUrls[0]);
    if (transcript && transcript.trim()) {
      isVoiceInput = true;
      text = text ? `${text}\n${transcript.trim()}` : transcript.trim();
    } else {
      const errMsg = "لم أتمكن من فهم الرسالة الصوتية، حاول مرة أخرى بصوت أوضح 🎙️";
      await admin.from("messages").insert({
        facebook_user_id: senderId, sender_type: "user",
        message_text: "🎙️ [رسالة صوتية غير مفهومة]", page_id: pageId,
      });
      await sendAndLog(admin, senderId, errMsg, pageId, Date.now());
      return;
    }
  }

  if (!text && imageUrls.length === 0) return;

  const userLog = imageUrls.length
    ? (text ? text + "\n" : "") + imageUrls.map((u) => `${IMAGE_MARK} ${u}`).join("\n")
    : (isVoiceInput ? `🎙️ ${text}` : text);

  const userMsgStart = Date.now();
  ensureFbProfile(admin, senderId, pageId).catch((e) => console.error("[messenger] profile fetch", e));
  await admin.from("messages").insert({
    facebook_user_id: senderId,
    sender_type: "user",
    message_text: userLog,
    page_id: pageId,
  });

  // Auto-moderation: silently ignore already-blocked users.
  const { data: blockRow } = await admin
    .from("blocked_users")
    .select("facebook_user_id, is_active")
    .eq("facebook_user_id", senderId)
    .eq("is_active", true)
    .maybeSingle();
  if (blockRow) { console.log("[messenger] blocked user, ignoring"); return; }

  // Enroll new users into active drip campaigns (fires only on first user msg).
  enrollInActiveDrips(admin, senderId).catch((e) => console.error("[messenger] drip enroll", e));

  const { data: settings } = await admin.from("bot_settings").select("*").limit(1).maybeSingle();
  if (!settings || !settings.is_active) { console.log("[messenger] inactive"); return; }

  // Auto-moderation: ask Mistral to classify the message. If it's abusive/insulting,
  // send a single Arabic warning, add the user to blocked_users, and stop.
  if (text && text.trim()) {
    const unsafe = await moderateMessage(text);
    if (unsafe) {
      const warning = "⚠️ رصدت لغة غير لائقة في رسالتك. تم حظرك ولن يرد عليك البوت بعد الآن. إذا كنت تعتقد أن هذا خطأ، يمكن للمشرف إعادة تفعيل حسابك من لوحة الإدارة.";
      await sendAndLog(admin, senderId, warning, pageId, userMsgStart);
      await admin.from("blocked_users").upsert({
        facebook_user_id: senderId,
        reason: unsafe.reason || "inappropriate_language",
        offending_message: text.slice(0, 500),
        is_active: true,
        blocked_at: new Date().toISOString(),
        unblocked_at: null,
      }, { onConflict: "facebook_user_id" });
      return;
    }
  }


  if (imageUrls.length > 0 && !text) {
    await sendAndLog(admin, senderId, ASK_PROMPT_AR, pageId, userMsgStart);
    return;
  }

  // === Text-command fallback for Facebook Lite / old clients that don't render quick replies ===
  if (text) {
    const normalized = text.replace(/[.،,!؟?]+$/g, "").trim();
    // active reading session → next / stop by typing
    const { data: activeSession } = await admin
      .from("book_sessions").select("identifier").eq("facebook_user_id", senderId).maybeSingle();
    if (activeSession) {
      if (/^(?:التالي|التالى|تالي|التالية|التاليه|next|المزيد|كمل|كمّل|واصل|استمر)$/i.test(normalized)) {
        await handleBookNext(admin, senderId, pageId);
        return;
      }
      if (/^(?:توقف|ايقاف|إيقاف|قف|stop|انهاء|إنهاء|كفى)$/i.test(normalized)) {
        await admin.from("book_sessions").delete().eq("facebook_user_id", senderId);
        await sendAndLog(admin, senderId, "تم إيقاف القراءة ✅", pageId);
        return;
      }
    }
    // just a number → pick from last search cache
    const numMatch = normalized.match(/^([0-9\u0660-\u0669\u06F0-\u06F9]{1,2})$/);
    if (numMatch) {
      const arabicDigits = numMatch[1]
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
      const idx = parseInt(arabicDigits, 10) - 1;
      const { data: cache } = await admin.from("book_search_cache")
        .select("results,created_at").eq("facebook_user_id", senderId).maybeSingle();
      const results = (cache?.results ?? []) as BookResult[];
      if (results.length && idx >= 0 && idx < results.length) {
        await handleBookRead(admin, senderId, results[idx].identifier, pageId);
        return;
      }
    }
  }

  // === Detect book / author intent → search archive.org ===
  if (text) {
    // author intent: "كاتب فلان" / "مؤلف فلان" / "كتب فلان" / "روايات فلان" / "أعمال فلان"
    const authorMatch = text.match(/^\s*(?:اريد|أريد|ابغى|ابغي|ابعت|ابعث|هات|جيب|ممكن|ابحث(?:\s+لي)?(?:\s+عن)?)?\s*(?:كاتب|مؤلف|كتب|روايات|اعمال|أعمال)\s+(.{2,80})$/iu);
    if (authorMatch) {
      const query = authorMatch[1].trim().replace(/[?؟.!،,]+$/, "");
      if (query.length >= 2) {
        await handleBookSearch(admin, senderId, query, pageId, userMsgStart, "author");
        return;
      }
    }
    // title / generic book intent
    const bookMatch = text.match(/^\s*(?:اريد|أريد|ابغى|ابغي|ابعت|ابعث|هات|جيب|ممكن|ابحث(?:\s+لي)?(?:\s+عن)?|اقرأ|اقرا)?\s*(?:كتاب|رواية|قصة|قصه)\s+(.{2,80})$/iu);
    if (bookMatch) {
      const query = bookMatch[1].trim().replace(/[?؟.!،,]+$/, "");
      if (query.length >= 2) {
        await handleBookSearch(admin, senderId, query, pageId, userMsgStart, "any");
        return;
      }
    }
  }



  const { data: memRows } = await admin
    .from("user_memory").select("key,value").eq("facebook_user_id", senderId);
  const memBlock = (memRows ?? []).length
    ? "ما تعرفه عن هذا المستخدم (لا تنسَه أبداً):\n" +
      (memRows ?? []).map((m: any) => `- ${m.key}: ${m.value}`).join("\n")
    : "لا توجد ذاكرة سابقة عن هذا المستخدم بعد.";

  const { data: history } = await admin
    .from("messages")
    .select("sender_type, message_text, created_at")
    .eq("facebook_user_id", senderId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const histAsc = (history ?? []).slice().reverse();

  let pendingImages: string[] = imageUrls.slice();
  if (pendingImages.length === 0 && text) {
    for (let i = histAsc.length - 2; i >= 0; i--) {
      const m: any = histAsc[i];
      if (m.sender_type === "bot") { if (m.message_text === ASK_PROMPT_AR) continue; break; }
      const urls = extractImages(m.message_text);
      if (urls.length) pendingImages = [...urls, ...pendingImages];
    }
  }

  const basePrompt = await pickPersona(admin, pageId, settings.system_prompt);

  // Length preference: admin default, optionally overridden by user memory when allow_customer_length_config is on.
  let effectiveLength: string = (settings as any).answer_length || "normal";
  if ((settings as any).allow_customer_length_config) {
    const pref = (memRows ?? []).find((m: any) => {
      const k = String(m.key || "").toLowerCase();
      return k === "preferred_length" || k === "answer_length" || k === "response_length";
    });
    const v = String(pref?.value || "").toLowerCase();
    if (v.includes("short") || v.includes("قصير") || v.includes("مختصر")) effectiveLength = "short";
    else if (v.includes("long") || v.includes("طويل") || v.includes("مفصل") || v.includes("تفصيل")) effectiveLength = "long";
    else if (v.includes("normal") || v.includes("عادي") || v.includes("طبيعي") || v.includes("standard")) effectiveLength = "normal";
  }
  const lengthInstruction =
    effectiveLength === "short"
      ? "طول الإجابة: قصير جداً. لخّص في 1-2 جملة قصيرة (أقل من 40 كلمة). لا تشرح إلا إذا طُلب."
      : effectiveLength === "long"
      ? "طول الإجابة: طويل ومفصّل. قدّم شرحاً وافياً بأقسام أو نقاط عند الحاجة (150-400 كلمة إن كان الموضوع يستحق)."
      : "طول الإجابة: طبيعي ومتوسط. أجب بوضوح دون إسهاب مبالغ (تقريباً 40-120 كلمة).";

  const tone = (settings as any).tone || "professional";
  const toneInstruction =
    tone === "gentle" ? "النغمة: لطيفة، هادئة، مطمئنة، مهذبة."
    : tone === "direct" ? "النغمة: مباشرة وموجزة. صلب الموضوع فوراً بدون مقدمات أو دردشة."
    : tone === "empathetic" ? "النغمة: متعاطفة، أظهر الاهتمام والفهم لمشاعر المستخدم قبل تقديم الحل."
    : tone === "friendly" ? "النغمة: ودّية ودافئة كصديق، طبيعية وشخصية، مع لمسة مرح خفيف عند المناسب."
    : "النغمة: مهنية واضحة ومهذبة.";

  const customerConfigInstruction = (settings as any).allow_customer_length_config
    ? "\n- إذا طلب المستخدم تغيير طول ردودك (\"اجعل ردودك أقصر/أطول\"، \"answer short/long\"...) استخدم save_memory بمفتاح preferred_length وقيمة short أو normal أو long، ثم تابع بالطول الجديد."
    : "";

  const systemPrompt = `اسمك هو "SolveBot GPT". إذا سألك أحد عن اسمك أو من أنت، عرّف نفسك بهذا الاسم دائماً. لا تذكر أنك Mistral أو أي نموذج آخر.

${basePrompt}

${memBlock}

${toneInstruction}
${lengthInstruction}

تعليمات مهمة:
- لا تنسَ أبداً أي معلومة عن المستخدم. كلما عرفت شيئاً جديداً (اسم، تفضيل، هدف، لغة، مهنة...)، استخدم أداة save_memory فوراً.${customerConfigInstruction}
- إذا طلب المستخدم تذكيراً ("ذكّرني بعد X دقائق") استخدم set_reminder.
- لأي عملية حسابية استخدم أداة calculator بدل التخمين.
- لتحويل العملات استخدم convert_currency (أسعار حقيقية محدّثة).
- لمعرفة الطقس استخدم get_weather.
- للترجمة بين اللغات استخدم translate.
- لأي معلومة قد تكون تغيّرت (أخبار، أسعار، طقس مستقبلي، رياضة، أحداث جارية، نتائج، تواريخ حديثة، حقائق لا تعرفها بيقين) استخدم web_search فوراً بدلاً من التخمين. إذا لزم مزيد من التفاصيل من نتيجة معيّنة، استخدم read_url على رابطها.
- إذا طلب المستخدم سماع الرد كصوت ("ارسلها صوت"، "voice note"، "اقرأها لي")، استخدم send_voice_note ثم أرسل رداً نصياً قصيراً يقول إنك أرسلت الملاحظة الصوتية.
- إذا طلب المستخدم صورة أو رسمة أو تصميماً أو "تخيّل"/"ارسم"/"اصنع صورة"/"generate image"، استخدم أداة generate_image فوراً بوصف واضح (يفضّل بالإنجليزية للجودة)، ثم أرسل رداً نصياً قصيراً يقول إنك أرسلت الصورة. لا تكتفِ بوصف الصورة نصياً.
- إذا طلب المستخدم رواية أو قصة طويلة متسلسلة:
  1) استخدم start_novel لتسجيل الرواية (اسأله عن العنوان/النوع/الفكرة إن لم يحدد، أو اقترح أنت ثم أكّد).
  2) اكتب الفصل بأسلوب أدبي ممتاز (500-1500 كلمة) بحوارات ووصف وإيقاع، ثم استدعِ save_novel_chapter لحفظه فوراً.
  3) في نهاية كل فصل اقترح خيارين أو ثلاثة لاتجاه الفصل التالي ودع المستخدم يختار.
  4) إذا طلب إكمال رواية سابقة استخدم list_my_novels ثم resume_novel قبل الكتابة لتلتقط الخيط.
  5) لا تكرر أحداثاً سبق كتابتها واحترم شخصيات وأسلوب الرواية المحفوظ.
- أجب دائماً بنفس لغة المستخدم. كن دقيقاً ومفيداً.
- التزم بالنغمة والطول المحددين أعلاه في كل الردود (إلا الروايات/الأكواد فتتبع طبيعتها).
- استخدم الذاكرة أعلاه في إجاباتك بشكل طبيعي.`;

  const chatMessages: any[] = [{ role: "system", content: systemPrompt }];

  const histForCtx = histAsc.slice(0, -1);
  for (const m of histForCtx) {
    const cleaned = stripImageMarkers(m.message_text);
    if (!cleaned) continue;
    chatMessages.push({ role: m.sender_type === "bot" ? "assistant" : "user", content: cleaned });
  }

  if (pendingImages.length > 0) {
    chatMessages.push({
      role: "user",
      content: [
        { type: "text", text: text || "حلل الصورة بدقة." },
        ...pendingImages.map((url) => ({ type: "image_url", image_url: url })),
      ],
    });
  } else {
    chatMessages.push({ role: "user", content: text });
  }

  const model = pendingImages.length > 0 ? VISION_MODEL : TEXT_MODEL;
  const reply = await runWithTools(chatMessages, model, senderId, admin);
  if (isVoiceInput) {
    const voiceResult = await sendVoiceNote(senderId, reply, "alloy", admin);
    let voiceOk = false;
    let voiceErr = "unknown";
    try {
      const parsed = JSON.parse(voiceResult);
      voiceOk = parsed?.ok === true;
      if (!voiceOk) voiceErr = parsed?.error || parsed?.detail || "unknown";
    } catch (e) {
      voiceErr = String(e);
    }
    if (!voiceOk) {
      console.error("[messenger] voice send failed, falling back to text. reason:", voiceErr);
      await sendAndLog(admin, senderId, reply, pageId, userMsgStart);
    } else {
      await admin.from("messages").insert({
        facebook_user_id: senderId, sender_type: "bot",
        message_text: reply, page_id: pageId,
        response_time_ms: Date.now() - userMsgStart,
      });
    }
  } else {
    await sendAndLog(admin, senderId, reply, pageId, userMsgStart);
  }
}

async function transcribeAudio(url: string): Promise<string | null> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableKey) { console.error("[messenger] LOVABLE_API_KEY missing for STT"); return null; }
  try {
    const audioRes = await fetch(url);
    if (!audioRes.ok) { console.error("[messenger] audio download failed", audioRes.status); return null; }
    const contentType = audioRes.headers.get("content-type") || "audio/mp4";
    const buf = await audioRes.arrayBuffer();
    const ext = contentType.includes("mpeg") ? "mp3"
      : contentType.includes("wav") ? "wav"
      : contentType.includes("webm") ? "webm"
      : contentType.includes("ogg") ? "ogg"
      : "m4a";
    const form = new FormData();
    form.append("model", "openai/gpt-4o-transcribe");
    form.append("file", new Blob([buf], { type: contentType }), `voice.${ext}`);
    const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}` },
      body: form,
    });
    if (!res.ok) {
      console.error("[messenger] STT failed", res.status, await res.text());
      return null;
    }
    const j = await res.json();
    return (j?.text ?? "").trim() || null;
  } catch (err) {
    console.error("[messenger] transcribe error", err);
    return null;
  }
}

async function runWithTools(messages: any[], model: string, senderId: string, admin: any): Promise<string> {
  const key = await getMistralKey();
  if (!key) { console.error("[messenger] MISTRAL_API_KEY missing"); return "الخدمة غير متاحة حالياً."; }

  let convo = messages.slice();
  for (let step = 0; step < 6; step++) {
    try {
      const res = await fetch(MISTRAL_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: convo, tools, tool_choice: "auto", max_tokens: 1500 }),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error("[messenger] Mistral error", res.status, t);
        if (res.status === 429) return "النموذج مشغول الآن، حاول بعد قليل.";
        return "حدث خطأ، حاول مرة أخرى.";
      }
      const json: any = await res.json();
      const msg = json?.choices?.[0]?.message;
      if (!msg) return "لم أتمكن من توليد رد.";

      const toolCalls = msg.tool_calls ?? [];
      if (!toolCalls.length) {
        return (msg.content ?? "").trim() || "تم.";
      }

      convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });

      for (const tc of toolCalls) {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch {}
        const result = await executeTool(tc.function?.name ?? "", args, senderId, admin);
        convo.push({ role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: result });
      }
    } catch (err) {
      console.error("[messenger] Mistral loop failed", err);
      return "تعذّر الاتصال بالنموذج.";
    }
  }
  return "تم تنفيذ الطلب.";
}

function extractImages(s: string): string[] {
  if (!s) return [];
  return s.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(IMAGE_MARK + " "))
    .map((l) => l.slice(IMAGE_MARK.length + 1).trim());
}
function stripImageMarkers(s: string): string {
  if (!s) return "";
  return s.split("\n")
    .map((l) => l.trim().startsWith(IMAGE_MARK + " ") ? "[صورة مرسلة]" : l)
    .join("\n").trim();
}

async function sendAndLog(admin: any, senderId: string, reply: string, pageId: string | null = null, userMsgStart: number | null = null) {
  await admin.from("messages").insert({
    facebook_user_id: senderId, sender_type: "bot", message_text: reply,
    page_id: pageId,
    response_time_ms: userMsgStart ? Date.now() - userMsgStart : null,
  });
  await sendToFacebook(senderId, reply);
}

async function sendToFacebook(senderId: string, reply: string) {
  const pageToken = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  if (!pageToken) { console.error("[messenger] FB_PAGE_ACCESS_TOKEN missing"); return; }
  for (const chunk of chunkText(reply, 1900)) {
    try {
      const r = await fetch(`${FB_API}?access_token=${encodeURIComponent(pageToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: senderId },
          messaging_type: "RESPONSE",
          message: { text: chunk },
        }),
      });
      if (!r.ok) console.error("[messenger] FB Send", r.status, await r.text());
    } catch (err) { console.error("[messenger] FB Send fetch failed", err); }
  }
}

function chunkText(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// ============ Deep Web Search & URL Reader ============
async function webSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return JSON.stringify({ ok: false, error: "empty_query" });

  const mistral = await mistralWebSearch(q);
  if (mistral) return mistral;

  // Fallback only if Mistral's official web tool is temporarily unavailable.
  const ddg = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const readerUrl = `https://r.jina.ai/${ddg}`;

  try {
    const res = await fetch(readerUrl, {
      headers: {
        "Accept": "text/plain",
        "X-Return-Format": "markdown",
        "X-Retain-Images": "none",
      },
    });

    if (!res.ok) return await fallbackBingSearch(q, `search_failed_${res.status}`);

    const txt = await res.text();
    // نظّف قليلاً: احذف قوائم اللغات/الفلاتر المتكررة في أعلى الصفحة
    const cleaned = txt
      .replace(/^[\s\S]*?Safe search:[^\n]*\n/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return JSON.stringify({
      ok: true,
      query: q,
      source: "duckduckgo",
      results_markdown: cleaned.slice(0, 6000),
    });
  } catch (err: any) {
    return await fallbackBingSearch(q, String(err?.message ?? err));
  }
}

let cachedWebSearchAgentId: string | null = null;

async function ensureWebSearchAgent(key: string): Promise<string | null> {
  if (cachedWebSearchAgentId) return cachedWebSearchAgentId;
  try {
    const res = await fetch(MISTRAL_AGENT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        name: "SolveBot GPT Deep Web Search",
        description: "Deep, accurate real-time web research agent for current information, news, sports, prices, and fact checking.",
        instructions:
          "You are SolveBot GPT's research agent. Use web_search_premium first for current news, sports, live/recent results, prices, and events. If needed, use web_search too. Search deeply, compare multiple sources, prefer authoritative/current sources, and include source names/URLs in the answer. If results conflict, say so and explain which source is stronger.",
        tools: [{ type: "web_search_premium" }],
        completion_args: { temperature: 0.1, top_p: 0.9 },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[messenger] websearch agent create failed", res.status, body);
      if (/web_search_premium|premium/i.test(body)) return await ensureBasicWebSearchAgent(key);
      return null;
    }
    const j = await res.json();
    cachedWebSearchAgentId = j?.id ?? null;
    return cachedWebSearchAgentId;
  } catch (err) {
    console.error("[messenger] websearch agent create error", err);
    return null;
  }
}

async function ensureBasicWebSearchAgent(key: string): Promise<string | null> {
  try {
    const res = await fetch(MISTRAL_AGENT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        name: "SolveBot GPT Web Search",
        description: "Accurate real-time web research agent.",
        instructions:
          "You are SolveBot GPT's research agent. Use web_search for all current or uncertain information. Search deeply, compare multiple sources, and include source names/URLs. If results conflict, say so.",
        tools: [{ type: "web_search" }],
        completion_args: { temperature: 0.1, top_p: 0.9 },
      }),
    });
    if (!res.ok) {
      console.error("[messenger] basic websearch agent create failed", res.status, await res.text());
      return null;
    }
    const j = await res.json();
    cachedWebSearchAgentId = j?.id ?? null;
    return cachedWebSearchAgentId;
  } catch (err) {
    console.error("[messenger] basic websearch agent create error", err);
    return null;
  }
}

async function mistralWebSearch(query: string): Promise<string | null> {
  const key = await getMistralKey();
  if (!key) return null;
  const agentId = await ensureWebSearchAgent(key);
  if (!agentId) return null;

  try {
    const res = await fetch(MISTRAL_CONVERSATIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        inputs:
          `ابحث بعمق ودقة عن: ${query}\n` +
          `اعتمد على نتائج حديثة ومصادر متعددة واذكر أسماء/روابط المصادر. لا تجب من الذاكرة إذا كانت المعلومة حالية.`,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[messenger] Mistral websearch conversation failed", res.status, body);
      if (res.status === 404 || res.status === 400) cachedWebSearchAgentId = null;
      return null;
    }
    const conv = await res.json();
    const answer = extractConversationText(conv);
    if (!answer) return null;
    return JSON.stringify({
      ok: true,
      query,
      source: "mistral_web_search",
      results_markdown: answer.slice(0, 12000),
      raw_outputs: JSON.stringify(conv?.outputs ?? []).slice(0, 6000),
    });
  } catch (err) {
    console.error("[messenger] Mistral websearch error", err);
    return null;
  }
}

function extractConversationText(conv: any): string {
  const chunks: string[] = [];
  for (const out of conv?.outputs ?? []) {
    const content = out?.content;
    if (typeof content === "string") chunks.push(content);
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c === "string") chunks.push(c);
        else if (typeof c?.text === "string") chunks.push(c.text);
        else if (typeof c?.content === "string") chunks.push(c.content);
        else if (c?.url && (c?.title || c?.source)) chunks.push(`- ${c.title ?? c.source}: ${c.url}`);
      }
    }
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function fallbackBingSearch(query: string, reason: string): Promise<string> {
  try {
    const bing = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const alt = await fetch(`https://r.jina.ai/${bing}`, {
      headers: { "Accept": "text/plain", "X-Return-Format": "markdown", "X-Retain-Images": "none" },
    });
    if (!alt.ok) return JSON.stringify({ ok: false, error: reason, fallback_error: `bing_${alt.status}` });
    const t = await alt.text();
    return JSON.stringify({ ok: true, query, source: "bing_fallback", results_markdown: t.slice(0, 9000) });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: reason, fallback_error: String(err?.message ?? err) });
  }
}

async function readUrl(url: string): Promise<string> {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return JSON.stringify({ ok: false, error: "invalid_url" });
  try {
    const res = await fetch(`https://r.jina.ai/${u}`, {
      headers: { "Accept": "text/plain", "X-Return-Format": "markdown" },
    });
    if (!res.ok) return JSON.stringify({ ok: false, error: `fetch_failed_${res.status}` });
    const txt = await res.text();
    return JSON.stringify({ ok: true, url: u, content: txt.slice(0, 8000) });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}


// ============ Archive.org Book Reader ============
const BOOK_BATCH_SIZE = 10;
const ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata";

type BookResult = { identifier: string; title: string; creator: string | null; pages: number };

type SearchMode = "title" | "author" | "any";

function buildArchiveQuery(query: string, mode: SearchMode): string {
  // Escape Lucene special characters that break archive.org's query parser.
  const esc = query.replace(/([+\-!(){}\[\]^"~*?:\\\/])/g, " ").replace(/\s+/g, " ").trim();
  const langFilter = "(language:Arabic OR language:ara OR language:ar)";
  const base = "mediatype:texts";
  if (mode === "author") {
    // Search across creator + title (some uploads mistakenly put the author in the title).
    return `(creator:(${esc}) OR title:(${esc})) AND ${base} AND ${langFilter}`;
  }
  if (mode === "title") {
    return `title:(${esc}) AND ${base} AND ${langFilter}`;
  }
  // "any" — broad fielded search across title/creator/subject/description.
  return `(title:(${esc}) OR creator:(${esc}) OR subject:(${esc}) OR description:(${esc})) AND ${base} AND ${langFilter}`;
}

async function archiveSearch(query: string, mode: SearchMode = "any"): Promise<BookResult[]> {
  const q = buildArchiveQuery(query, mode);
  const url = new URL(ARCHIVE_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.append("fl[]", "identifier");
  url.searchParams.append("fl[]", "title");
  url.searchParams.append("fl[]", "creator");
  url.searchParams.append("fl[]", "imagecount");
  url.searchParams.append("fl[]", "downloads");
  url.searchParams.append("sort[]", "downloads desc");
  url.searchParams.set("rows", "50");
  url.searchParams.set("output", "json");

  try {
    const res = await fetch(url.toString(), { headers: { "User-Agent": "SolveBotGPT/1.0" } });
    if (!res.ok) { console.error("[book] search failed", res.status); return []; }
    const j = await res.json();
    const docs: any[] = j?.response?.docs ?? [];
    const results: BookResult[] = [];
    const seen = new Set<string>();
    for (const d of docs) {
      const pages = Number(d?.imagecount ?? 0);
      if (!pages || pages < 3) continue; // skip items without readable page scans
      const id = String(d.identifier);
      if (seen.has(id)) continue;
      seen.add(id);
      const title = String(Array.isArray(d.title) ? d.title[0] : d.title ?? "").slice(0, 80);
      const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator ?? null;
      results.push({
        identifier: id,
        title: title || id,
        creator: creator ? String(creator).slice(0, 60) : null,
        pages,
      });
      if (results.length >= 10) break;
    }
    // Fallback: if strict search returned nothing, retry without language filter.
    if (!results.length && mode !== "title") {
      const url2 = new URL(ARCHIVE_SEARCH_URL);
      const esc = query.replace(/([+\-!(){}\[\]^"~*?:\\\/])/g, " ").replace(/\s+/g, " ").trim();
      const q2 = mode === "author"
        ? `(creator:(${esc}) OR title:(${esc})) AND mediatype:texts`
        : `(title:(${esc}) OR creator:(${esc}) OR subject:(${esc})) AND mediatype:texts`;
      url2.searchParams.set("q", q2);
      ["identifier", "title", "creator", "imagecount"].forEach((f) => url2.searchParams.append("fl[]", f));
      url2.searchParams.append("sort[]", "downloads desc");
      url2.searchParams.set("rows", "50");
      url2.searchParams.set("output", "json");
      const r2 = await fetch(url2.toString(), { headers: { "User-Agent": "SolveBotGPT/1.0" } });
      if (r2.ok) {
        const j2 = await r2.json();
        for (const d of (j2?.response?.docs ?? []) as any[]) {
          const pages = Number(d?.imagecount ?? 0);
          if (!pages || pages < 3) continue;
          const id = String(d.identifier);
          if (seen.has(id)) continue;
          seen.add(id);
          const title = String(Array.isArray(d.title) ? d.title[0] : d.title ?? "").slice(0, 80);
          const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator ?? null;
          results.push({
            identifier: id, title: title || id,
            creator: creator ? String(creator).slice(0, 60) : null, pages,
          });
          if (results.length >= 10) break;
        }
      }
    }
    return results;
  } catch (e) { console.error("[book] search error", e); return []; }
}

function bookPageUrl(identifier: string, pageIndex: number): string {
  // Archive.org page-image endpoint. `n{N}` is 0-indexed. `_w800` bounds width to 800px.
  return `https://archive.org/download/${encodeURIComponent(identifier)}/page/n${pageIndex}_w800.jpg`;
}

async function fbSendRaw(senderId: string, message: any): Promise<boolean> {
  const pageToken = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  if (!pageToken) { console.error("[book] FB_PAGE_ACCESS_TOKEN missing"); return false; }
  try {
    const r = await fetch(`${FB_API}?access_token=${encodeURIComponent(pageToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: senderId }, messaging_type: "RESPONSE", message }),
    });
    if (!r.ok) { console.error("[book] FB send", r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error("[book] FB send err", e); return false; }
}

async function sendBookImage(senderId: string, url: string): Promise<boolean> {
  return await fbSendRaw(senderId, { attachment: { type: "image", payload: { url, is_reusable: false } } });
}

async function sendContinueButton(senderId: string, text: string, hasNext: boolean) {
  // Quick Replies for Messenger; plain-text hint for Facebook Lite / clients
  // that don't render quick replies at all.
  const hint = hasNext
    ? "\n\n➡️ اكتب «التالي» للصفحات التالية، أو «توقف» للإنهاء."
    : "\n\n✖️ اكتب «توقف» للإنهاء.";
  const quick_replies: any[] = [];
  if (hasNext) {
    quick_replies.push({ content_type: "text", title: "الصفحات التالية ⬅️", payload: "BOOK_NEXT" });
  }
  quick_replies.push({ content_type: "text", title: "إيقاف القراءة ✖️", payload: "BOOK_STOP" });
  await fbSendRaw(senderId, { text: (text + hint).slice(0, 2000), quick_replies });
}

async function handleBookSearch(admin: any, senderId: string, query: string, pageId: string | null, userMsgStart: number, mode: SearchMode = "any") {
  const label = mode === "author" ? `مؤلف «${query}»` : `«${query}»`;
  await sendAndLog(admin, senderId, `🔎 أبحث عن ${label} في archive.org…`, pageId, userMsgStart);
  const results = await archiveSearch(query, mode);
  if (!results.length) {
    await sendAndLog(admin, senderId, "لم أجد كتاباً مطابقاً بصور صفحات على archive.org 😕 جرّب اسماً آخر أو تهجئة مختلفة.", pageId);
    return;
  }
  await admin.from("book_search_cache").upsert({
    facebook_user_id: senderId, results, created_at: new Date().toISOString(),
  }, { onConflict: "facebook_user_id" });

  // Send a plain-text numbered list + Quick Replies so it works on Messenger Lite
  // (generic/carousel templates are not rendered there).
  const lines = results.map((r, i) => {
    const meta = [r.creator, `${r.pages} صفحة`].filter(Boolean).join(" · ");
    return `${i + 1}. ${r.title}${meta ? `\n   ${meta}` : ""}`;
  });
  const text = `📚 نتائج البحث عن «${query}»:\n\n${lines.join("\n\n")}\n\nاضغط رقم الكتاب للقراءة 👇`;
  const quick_replies = results.slice(0, 11).map((r, i) => ({
    content_type: "text",
    title: `${i + 1} 📖`,
    payload: `BOOK_READ:${r.identifier}`,
  }));
  await fbSendRaw(senderId, { text: text.slice(0, 2000), quick_replies });

  await admin.from("messages").insert({
    facebook_user_id: senderId, sender_type: "bot",
    message_text: `[📚 ${results.length} نتائج للبحث: ${query}]`,
    page_id: pageId,
  });
}

async function handleBookRead(admin: any, senderId: string, identifier: string, pageId: string | null) {
  // Verify the book has pages (from search cache or fresh metadata).
  const { data: cache } = await admin.from("book_search_cache")
    .select("results").eq("facebook_user_id", senderId).maybeSingle();
  const cached = ((cache?.results ?? []) as BookResult[]).find((r) => r.identifier === identifier);
  let title = cached?.title ?? identifier;
  let total = cached?.pages ?? 0;

  if (!total) {
    try {
      const r = await fetch(`${ARCHIVE_METADATA_URL}/${encodeURIComponent(identifier)}`);
      if (r.ok) {
        const j = await r.json();
        total = Number(j?.metadata?.imagecount ?? 0);
        title = String(j?.metadata?.title ?? title).slice(0, 200);
      }
    } catch (_e) { /* ignore */ }
  }
  if (!total) {
    await sendAndLog(admin, senderId, "عذراً، هذا الكتاب لا يوفّر صور صفحات قابلة للقراءة 😕", pageId);
    return;
  }

  await admin.from("book_sessions").upsert({
    facebook_user_id: senderId, identifier, title, total_pages: total, current_page: 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: "facebook_user_id" });

  await sendAndLog(admin, senderId, `📖 «${title}»\nإجمالي الصفحات: ${total}\nأرسل الآن أول ${Math.min(BOOK_BATCH_SIZE, total)} صفحات…`, pageId);
  await sendPageBatch(admin, senderId, pageId);
}

async function handleBookNext(admin: any, senderId: string, pageId: string | null) {
  const { data: session } = await admin.from("book_sessions")
    .select("*").eq("facebook_user_id", senderId).maybeSingle();
  if (!session) {
    await sendAndLog(admin, senderId, "لا توجد جلسة قراءة نشطة. اطلب كتاباً جديداً 📚", pageId);
    return;
  }
  await sendPageBatch(admin, senderId, pageId);
}

async function sendPageBatch(admin: any, senderId: string, pageId: string | null) {
  const { data: session } = await admin.from("book_sessions")
    .select("*").eq("facebook_user_id", senderId).maybeSingle();
  if (!session) return;

  const start: number = session.current_page ?? 0;
  const total: number = session.total_pages ?? 0;
  const end = Math.min(start + BOOK_BATCH_SIZE, total);

  let sent = 0;
  for (let i = start; i < end; i++) {
    const ok = await sendBookImage(senderId, bookPageUrl(session.identifier, i));
    if (ok) sent++;
    await new Promise((r) => setTimeout(r, 300));
  }

  const newCurrent = start + sent;
  await admin.from("book_sessions").update({
    current_page: newCurrent, updated_at: new Date().toISOString(),
  }).eq("facebook_user_id", senderId);

  const hasNext = newCurrent < total;
  const label = hasNext
    ? `الصفحات ${start + 1}-${newCurrent} من ${total}`
    : `انتهى الكتاب 📖✨ (${newCurrent}/${total})`;
  await sendContinueButton(senderId, label, hasNext);
  await admin.from("messages").insert({
    facebook_user_id: senderId, sender_type: "bot",
    message_text: `[📖 ${label} — ${session.title ?? session.identifier}]`,
    page_id: pageId,
  });

  if (!hasNext) await admin.from("book_sessions").delete().eq("facebook_user_id", senderId);
}



