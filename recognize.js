require("dotenv-safe").config();
const fs = require("fs");
const path = require("path");
const { exiftool } = require("exiftool-vendored");
const { OpenAI } = require("openai");

const IMAGE_DIR = process.argv[2] || "./images"; // Get path argument or default to './images'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Get API key from environment
const CONCURRENT_LIMIT = 10; // Limit concurrent requests

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function describeImage(imagePath) {
  const base64Image = fs.readFileSync(imagePath, { encoding: "base64" });
  const base64String = `data:image/jpeg;base64,${base64Image}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `
              Describe this image in a way that helps with searching.
              Queries will likely include key features of the image as well as what it's "about."
              If there is text in the image, read it and summarize.
              If the image appears to be a meme or image macro (e.g., text added over photo or illustration), use the word "meme" in the description.
              If you recognize a famous person or character in the image, mention them by name.
              Just respond with a human-readable description that includes the keywords in the description.
              Your response will be placed in the image's metadata as a comment, directly.
              Do not include any other text or labels (e.g., "Metadata: "). Just the description.
            `,
          },
          { type: "image_url", image_url: { url: base64String } },
        ],
      },
    ],
  });

  return response.choices[0]?.message?.content.trim();
}

async function processImages() {
  const files = fs
    .readdirSync(IMAGE_DIR)
    .filter((file) => /\.(jpg|jpeg|png|gif|bmp|tiff)$/i.test(file));

  let processedCount = 0;
  const totalFiles = files.length;
  const queue = [];

  async function processNext() {
    if (files.length === 0) return;
    const file = files.pop();
    const imagePath = path.join(IMAGE_DIR, file);
    processedCount++;
    console.log(`Processing: ${file} (${processedCount}/${totalFiles}) ${((processedCount / totalFiles) * 100).toFixed(1)}%`);

    try {
      // Check if metadata already exists
      const metadata = await exiftool.read(imagePath);
      if (metadata.Comment) {
        console.log(`Skipping ${file} (already processed)`);
        return;
      }

      const description = await describeImage(imagePath);
      if (description) {
        console.log(`Metadata: ${description}`);
        await exiftool.write(
          imagePath,
          { Comment: description, Keywords: description },
          ["-overwrite_original", "-EXIF:ImageDescription=" + description]
        );
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    } finally {
      if (files.length > 0) {
        await processNext();
      }
    }
  }

  for (let j = 0; j < CONCURRENT_LIMIT; j++) {
    queue.push(processNext());
  }

  await Promise.all(queue);
  exiftool.end();
  console.log("Processing complete!");
}

processImages();
