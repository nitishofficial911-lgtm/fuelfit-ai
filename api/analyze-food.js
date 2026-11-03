export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Food scanner is not configured. Add GEMINI_API_KEY in Vercel Environment Variables and redeploy." });

  try {
    const { image, mimeType } = req.body || {};
    if (typeof image !== "string" || !image || image.length > 12_000_000) {
      return res.status(400).json({ error: "Please upload a valid food photo under 8 MB." });
    }
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    const type = allowed.includes(mimeType) ? mimeType : "image/jpeg";

    const prompt = `You are a careful food-image nutrition estimation assistant. Identify the visible food and estimate a plausible serving amount from the image. Do not pretend the image reveals exact weight or ingredients. If multiple foods are visible, estimate the whole visible meal and list the main items. Return ONLY valid JSON with this exact shape:
{
  "foodName": "short food name",
  "serving": "estimated visible portion, with uncertainty",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "confidence": "Low, Medium, or High",
  "note": "one short sentence explaining uncertainty"
}
Use kcal for calories and grams for nutrients. All numeric values must be non-negative. If the image is not food, set foodName to "Food not recognised", calories and nutrient values to 0, confidence to "Low", and explain in note. Estimates are approximate, not medical advice.`;

    const requestBody = JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: type, data: image } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    // Google can temporarily return 503 when model capacity is busy.
    // Retry a small number of times with exponential backoff.
    let response;
    let payload;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + encodeURIComponent(apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody
      });

      if (response.status !== 503 || attempt === 2) {
        payload = await response.json();
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }

    if (!response.ok) {
      const detail = payload?.error?.message || "The food analysis service returned an error.";
      const friendly = response.status === 503
        ? "Google's AI service is temporarily busy. FuelFit tried again automatically, but the service is still unavailable. Please try again shortly."
        : detail;
      return res.status(response.status === 429 ? 429 : 502).json({ error: friendly });
    }

    const raw = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
    const result = JSON.parse(cleaned);
    const fields = ["calories", "protein", "carbs", "fat", "fiber"];
    for (const field of fields) {
      if (!Number.isFinite(Number(result[field])) || Number(result[field]) < 0) {
        throw new Error("The AI returned incomplete nutrition values. Please try another photo.");
      }
      result[field] = Math.round(Number(result[field]) * 10) / 10;
    }
    result.foodName = String(result.foodName || "Food estimate").slice(0, 100);
    result.serving = String(result.serving || "Visible portion; amount uncertain").slice(0, 160);
    result.confidence = ["Low", "Medium", "High"].includes(result.confidence) ? result.confidence : "Low";
    result.note = String(result.note || "Nutrition values are estimates from the photo.").slice(0, 300);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not analyse this photo. Please try again." });
  }
}