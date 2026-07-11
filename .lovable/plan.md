
## نظرة عامة

سأضيف 6 ميزات على 3 مراحل في نفس الجلسة. كل مرحلة لها هجرة قاعدة بيانات + edge function + صفحة(صفحات) واجهة.

---

## المرحلة 1 — Broadcasting (إرسال جماعي)

**قاعدة البيانات:**
- جدول `broadcasts`: نص الرسالة، الحالة (draft/sending/sent/failed)، عدد المرسل، عدد الفاشل، تاريخ الإنشاء.
- جدول `broadcast_recipients`: broadcast_id, facebook_user_id, status, error.

**Edge function `broadcast-send`:**
- يستقبل `broadcast_id`.
- يجلب كل `facebook_user_id` فريد من جدول `messages` تفاعل آخر 7 أيام (احتراماً لسياسة الـ 24 ساعة لميتا — في الحقيقة 7 أيام مع `MESSAGE_TAG`، 24 ساعة بدونها).
- يرسل عبر FB Send API مع `messaging_type: MESSAGE_TAG`, `tag: ACCOUNT_UPDATE`.
- يحدّث عدادات النجاح/الفشل.

**واجهة `/broadcasts`:**
- جدول الحملات السابقة.
- زر "حملة جديدة" → نموذج: نص الرسالة + معاينة عدد المستلمين + زر إرسال.

---

## المرحلة 2 — Drip Campaigns + Personas

**قاعدة البيانات:**
- `drip_campaigns`: name, is_active, steps (jsonb مثل `[{day:1, message:"..."},{day:3,...},{day:7,...}]`).
- `drip_enrollments`: facebook_user_id, campaign_id, enrolled_at, last_step_index, completed.
- `personas`: name, system_prompt, page_id (nullable), active_from_hour, active_to_hour, priority, is_default.

**تعديل `messenger`:**
- عند أول رسالة لمستخدم جديد → تسجيله في كل حملات drip النشطة.
- اختيار persona ديناميكياً حسب `page_id` للصفحة + الوقت الحالي، fallback إلى bot_settings.

**Edge function `drip-runner`:**
- يستدعى عبر pg_cron كل ساعة.
- يجد المسجلين الذين حان موعد خطوتهم التالية → يرسل الرسالة → يحدّث `last_step_index`.

**واجهات:**
- `/drips`: قائمة الحملات + نموذج إنشاء (اسم + خطوات).
- `/personas`: قائمة الشخصيات + نموذج إنشاء.

---

## المرحلة 3 — لوحة التحكم المحسّنة

**قاعدة البيانات:**
- إضافة عمود `response_time_ms` إلى `messages` (للرسائل من نوع `bot`).
- جدول `message_feedback`: message_id, rating (1-5 أو 👍/👎)، اختياري.

**صفحة `/dashboard` محسّنة:**
- **بطاقات إحصائيات**: إجمالي الرسائل اليوم/الأسبوع، عدد المستخدمين الفريد، متوسط زمن الرد، نسبة الرضا.
- **مخطط**: الرسائل عبر آخر 30 يوم.
- **أكثر الأسئلة تكراراً**: تجميع كلمات مفتاحية بسيط من رسائل المستخدمين.
- **بحث**: حقل يبحث في `messages.message_text` ILIKE + filter حسب `facebook_user_id`.
- **زر تصدير CSV**: ينزّل كل المحادثات (أو نتائج البحث الحالية).

---

## ملاحظات تقنية

- جدول `messages` به فعلاً `created_at` و`sender_type` — يكفي حساب زمن الرد من فرق الوقت بين رسالة user وأول رد bot لنفس المستخدم بعدها.
- كل الـ edge functions الجديدة ستستخدم `service_role` للوصول الكامل.
- pg_cron يحتاج تفعيل (سأضيفه في الهجرة).
- صفحات الواجهة الجديدة محمية بـ admin role (موجود مسبقاً عبر `has_role`).
- ميتا policy: الرسائل الترويجية تتطلب tag مناسب — سأستخدم `ACCOUNT_UPDATE` كافتراضي وأشير في الواجهة لاختيار آخر إن أردت.

---

## الترتيب الزمني للتنفيذ

1. هجرة شاملة لكل الجداول الجديدة + عمود response_time_ms + تفعيل pg_cron.
2. كتابة edge function `broadcast-send`.
3. كتابة edge function `drip-runner` + جدولته كل ساعة.
4. تعديل `messenger` لإضافة: تسجيل drip + اختيار persona + حساب response_time + تتبع page_id.
5. صفحات الواجهة: Broadcasts, Drips, Personas, Dashboard المحسّن.

**عدد الملفات المتوقعة:** ~12 ملف جديد + 3 تعديلات.

هل أبدأ التنفيذ؟
