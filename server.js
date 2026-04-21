const express = require("express");
const cors = require("cors");
const Busboy = require("busboy");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, AlignmentType
} = require("docx");

const app = express();
app.use(cors());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const uploads = [];
    busboy.on("file", (fieldname, file, info) => {
      const { filename } = info;
      const chunks = [];
      file.on("data", chunk => chunks.push(chunk));
      file.on("end", () => uploads.push({ filename, buffer: Buffer.concat(chunks) }));
    });
    busboy.on("finish", () => resolve(uploads));
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

async function extractText(buffer, filename) {
  const ext = filename.split(".").pop().toLowerCase();

  if (ext === "txt" || ext === "md") return buffer.toString("utf-8");

  if (ext === "docx" || ext === "doc") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === "pdf") {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const imageData = {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: "application/pdf"
      }
    };
    const result = await model.generateContent([
      imageData,
      "You are a document transcription expert. Carefully read all text in this document. IMPORTANT RULES: 1) Every word must be separated by a space. 2) Never join two words together without a space between them. 3) Sentences must end with proper punctuation. 4) Each new topic or paragraph should be on a new line. 5) Preserve all headings, bullet points and numbered lists exactly as they appear. Transcribe all the text now, following these rules strictly."
    ]);
    return result.response.text();
  }

  if (["jpg", "jpeg", "png"].includes(ext)) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const imageData = {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: ext === "png" ? "image/png" : "image/jpeg"
      }
    };
    const result = await model.generateContent([
      imageData,
      "You are a document transcription expert. Carefully read all text in this image. IMPORTANT RULES: 1) Every word must be separated by a space. 2) Never join two words together without a space between them. 3) Sentences must end with proper punctuation. 4) Each new topic or paragraph should be on a new line. 5) Fix any OCR errors or joined words you notice. Transcribe all the text now, following these rules strictly."
    ]);
    return result.response.text();
  }

  return `[Unsupported file: ${filename}]`;
}
function buildDocx(sections) {
  const children = [];

  // Cover title
  children.push(new Paragraph({
    text: "WorkBeta Compiled Document",
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 600 }
  }));

  children.push(new Paragraph({
    children: [new TextRun({
      text: `Generated on ${new Date().toDateString()} · ${sections.length} file(s)`,
      color: "888888",
      size: 20,
      italics: true
    })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 800 }
  }));

  sections.forEach((section, idx) => {
    // Section heading
    children.push(new Paragraph({
      text: `Section ${idx + 1}: ${section.filename}`,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 600, after: 300 },
      border: {
        bottom: { color: "1B5EE8", size: 6, style: "single" }
      }
    }));

    const lines = section.text
      .split("\n")
      .map(l => l.trim());

    if (lines.filter(l => l.length > 0).length === 0) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: "[No readable text found]",
          italics: true,
          color: "999999",
          size: 22
        })],
        spacing: { after: 200 }
      }));
    } else {
      lines.forEach(line => {
        if (line.length === 0) {
          // Empty line becomes a spacer paragraph
          children.push(new Paragraph({
            text: "",
            spacing: { after: 160 }
          }));
        } else if (
          line.endsWith(':') ||
          /^[A-Z][A-Z\s]{3,}$/.test(line) ||
          (line.length < 60 && line === line.toUpperCase() && line.length > 3)
        ) {
          // Looks like a heading
          children.push(new Paragraph({
            children: [new TextRun({
              text: line,
              bold: true,
              size: 26,
              font: "Calibri",
              color: "1140A6"
            })],
            spacing: { before: 320, after: 160 }
          }));
        } else if (/^[-•*]\s/.test(line) || /^\d+[.)]\s/.test(line)) {
          // Bullet or numbered list item
          children.push(new Paragraph({
            children: [new TextRun({
              text: line,
              size: 24,
              font: "Calibri"
            })],
            indent: { left: 360 },
            spacing: { after: 120 }
          }));
        } else {
          // Normal paragraph
          children.push(new Paragraph({
            children: [new TextRun({
              text: line,
              size: 24,
              font: "Calibri"
            })],
            spacing: { after: 200 },
            indent: { firstLine: 360 }
          }));
        }
      });
    }

    // Page break between sections except last
    if (idx < sections.length - 1) {
      children.push(new Paragraph({
        children: [new PageBreak()]
      }));
    }
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 24 },
          paragraph: { spacing: { line: 360 } }
        }
      }
    },
    sections: [{ 
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
        }
      },
      children 
    }]
  });

  return Packer.toBuffer(doc);
}
app.post("/convertNotes", async (req, res) => {
  try {
    const uploads = await parseMultipart(req);
    if (!uploads.length) return res.status(400).send("No files received.");
    const sections = await Promise.all(
      uploads.map(async ({ filename, buffer }) => ({
        filename,
        text: await extractText(buffer, filename)
      }))
    );
    const docBuffer = await buildDocx(sections);
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.set("Content-Disposition", 'attachment; filename="WorkBeta_Document.docx"');
    res.status(200).send(docBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WorkBeta running on port ${PORT}`));