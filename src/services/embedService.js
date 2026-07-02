const embedText = async (text) => {
  const response = await fetch(
    "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: [text], // pass an array
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();

  return data[0];
};

module.exports = { embedText };