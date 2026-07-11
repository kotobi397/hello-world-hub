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
        "أنشئ/تخيّل صورة من وصف نصي وأرسلها للمستخدم على ماسنجر. استخدمها كلما طلب المستخدم صورة أو رسمة أو تصميماً أو تخيّل مشهد. مرّر وصفاً واضحاً باللغة الإنجليزية أفضل (إن أمكن) للحصول على أفضل جودة.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "وصف تفصيلي للصورة المطلوبة (يفضل الإنجليزية لجودة أعلى، لكن العربية تعمل أيضاً).",
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
      return await generateImage(senderId, String(args.prompt ?? ""), admin);
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
  const key = Deno.env.get("MISTRAL_API_KEY");
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

async function generateImage(senderId: string, prompt: string, admin: any): Promise<string> {
  const key = Deno.env.get("MISTRAL_API_KEY");
  const pageToken = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  if (!key) return JSON.stringify({ ok: false, error: "no_image_provider" });
  if (!pageToken) return JSON.stringify({ ok: false, error: "fb_token_missing" });
  if (!prompt.trim()) return JSON.stringify({ ok: false, error: "empty_prompt" });

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
      body: JSON.stringify({ agent_id: agentId, inputs: prompt }),
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
    const imgBuf = new Uint8Array(await fileRes.arrayBuffer());

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

  // Enroll new users into active drip campaigns (fires only on first user msg).
  enrollInActiveDrips(admin, senderId).catch((e) => console.error("[messenger] drip enroll", e));

  const { data: settings } = await admin.from("bot_settings").select("*").limit(1).maybeSingle();
  if (!settings || !settings.is_active) { console.log("[messenger] inactive"); return; }

  if (imageUrls.length > 0 && !text) {
    await sendAndLog(admin, senderId, ASK_PROMPT_AR, pageId, userMsgStart);
    return;
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
  const systemPrompt = `اسمك هو "SolveBot GPT". إذا سألك أحد عن اسمك أو من أنت، عرّف نفسك بهذا الاسم دائماً. لا تذكر أنك Mistral أو أي نموذج آخر.

${basePrompt}

${memBlock}

تعليمات مهمة:
- لا تنسَ أبداً أي معلومة عن المستخدم. كلما عرفت شيئاً جديداً (اسم، تفضيل، هدف، لغة، مهنة...)، استخدم أداة save_memory فوراً.
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
  const key = Deno.env.get("MISTRAL_API_KEY");
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
  const key = Deno.env.get("MISTRAL_API_KEY");
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


