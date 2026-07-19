const express = require("express");
const cors = require("cors");
const Busboy = require("busboy");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const Groq = require("groq-sdk");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  PageBreak,
  AlignmentType,
} = require("docx");

const app = express();
app.use(cors());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const uploads = [];
    busboy.on("file", (fieldname, file, info) => {
      const { filename } = info;
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("end", () =>
        uploads.push({ filename, buffer: Buffer.concat(chunks) })
      );
    });
    busboy.on("finish", () => resolve(uploads));
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

async function extractText(buffer, filename) {
  const ext = filename.split(".").pop().toLowerCase();

  if (ext === "txt" || ext === "md") {
    return buffer.toString("utf-8");
  }

  if (ext === "docx" || ext === "doc") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === "pdf") {
    try {
      const result = await pdfParse(buffer);
      const text = result.text.trim();
      if (text.length > 50) return text;
    } catch (e) {
      console.log("pdf-parse failed, returning empty");
    }
    return "[Could not extract PDF text]";
  }

  if (["jpg", "jpeg", "png"].includes(ext)) {
    const mimeType = ext === "png" ? "image/png" : "image/jpeg";
    const base64 = buffer.toString("base64");
    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
              },
            },
            {
              type: "text",
              text: "Transcribe all text in this image. Ensure every word is properly spaced. Preserve paragraph breaks and structure. Return only the transcribed text.",
            },
          ],
        },
      ],
      max_tokens: 4096,
    });
    return response.choices[0].message.content;
  }

  return `[Unsupported file: ${filename}]`;
}

function buildDocx(sections) {
  const children = [];

  children.push(
    new Paragraph({
      text: "WorkBeta Compiled Document",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Generated on ${new Date().toDateString()} - ${sections.length} file(s)`,
          color: "888888",
          size: 20,
        }),
      ],
      alignment: AlignmentType.CENTER,
    })
  );

  sections.forEach((section, idx) => {
    children.push(
      new Paragraph({
        text: `Section ${idx + 1}: ${section.filename}`,
        heading: HeadingLevel.HEADING_1,
      })
    );

    const lines = section.text
      .split("\n")
      .map((l) => l.trim());

    if (lines.filter((l) => l.length > 0).length === 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "[No readable text found]",
              italics: true,
              color: "999999",
            }),
          ],
        })
      );
    } else {
      lines.forEach((line) => {
        children.push(
  new Paragraph({
    children: [
      new TextRun({
        text: line,
        size: 24,
        font: "Calibri",
      }),
    ],
    spacing: { after: 200, line: 360 },
  })
);
      });
    }

    if (idx < sections.length - 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  });

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

app.post("/convertNotes", async (req, res) => {
  try {
    const uploads = await parseMultipart(req);
    if (!uploads.length) return res.status(400).send("No files received.");

    const sections = [];
    for (const { filename, buffer } of uploads) {
      const text = await extractText(buffer, filename);
      sections.push({ filename, text });
      await new Promise((r) => setTimeout(r, 2000));
    }

    const docBuffer = await buildDocx(sections);
    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.set(
      "Content-Disposition",
      'attachment; filename="WorkBeta_Document.docx"'
    );
    res.status(200).send(docBuffer);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WorkBeta running on port ${PORT}`));