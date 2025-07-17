require("dotenv-safe").config();
const fs = require("fs");
const path = require("path");
const { exiftool } = require("exiftool-vendored");
const { OpenAI } = require("openai");
const { spawn } = require("child_process");
const tmp = require("tmp");

const IMAGE_DIR = process.argv[2] || "./images"; // Get path argument or default to './images'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Get API key from environment
const CONCURRENT_LIMIT = 5; // Limit concurrent requests

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function extractFrames(videoPath, numFrames = 3) {
  return new Promise((resolve, reject) => {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const outputPattern = path.join(tmpDir, "frame-%d.jpg");
    const ffmpeg = spawn("ffmpeg", [
      "-i", videoPath,
      "-vf", `select='not(mod(n,${Math.floor(30 / numFrames)}))',scale=320:-1`,
      "-vsync", "vfr",
      outputPattern
    ]);

    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffmpeg failed"));
      fs.readdir(tmpDir, (err, files) => {
        if (err) return reject(err);
        resolve(files.map(file => path.join(tmpDir, file)));
      });
    });
  });
}

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
            text: "Describe this image in a way that helps with searching, including key objects, colors, and themes.",
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
    .filter((file) => /\.(jpg|jpeg|png|gif|bmp|tiff|mp4|mov|avi|gif)$/i.test(file));

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
      const metadata = await exiftool.read(imagePath);
      if (metadata.Comment) {
        console.log(`Skipping ${file} (already processed)`);
        return;
      }

      let descriptions = [];
      if (/\.(mp4|mov|avi|gif)$/i.test(file)) {
        console.log(`Extracting frames from video: ${file}`);
        const frames = await extractFrames(imagePath, 3);
        for (const frame of frames) {
          const description = await describeImage(frame);
          if (description) descriptions.push(description);
          fs.unlinkSync(frame); // Cleanup extracted frame
        }
      } else {
        const description = await describeImage(imagePath);
        if (description) descriptions.push(description);
      }

      if (descriptions.length) {
        const finalDescription = descriptions.join("; ");
        console.log(`Metadata: ${finalDescription}`);
        await exiftool.write(
          imagePath,
          { Comment: finalDescription, Keywords: finalDescription },
          ["-overwrite_original", "-EXIF:ImageDescription=" + finalDescription]
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
