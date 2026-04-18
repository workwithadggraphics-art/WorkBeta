const functions = require("firebase-functions");
const Busboy = require("busboy");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  PageBreak,
  AlignmentType,
} = require("docx");

// ── Helper: extract text from each file type ──────────────────────────────

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
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === "jpg" || ext === "jpeg" || ext === "png") {
    // OCR — read text from image using Tesseract
    const { data } = await Tesseract.recognize(buffer, "eng", {
      logger: () => {}, // suppress logs
    });
    return data.text;
  }

  return `[Unsupported file: ${filename}]`;
}

// ── Helper: parse multipart form upload ──────────────────────────────────

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const uploads = []; // [{ filename, buffer }]
    const buffers = {};

    busboy.on("file", (fieldname, file, info) => {
      const { filename } = info;
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("end", () => {
        uploads.push({ filename, buffer: Buffer.concat(chunks) });
      });
    });

    busboy.on("finish", () => resolve(uploads));
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

// ── Helper: build .docx from extracted sections ──────────────────────────

function buildDocx(sections) {
  const children = [];

  // Cover title
  children.push(
    new Paragraph({
      text: "WorkBeta Compiled Document",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Generated on ${new Date().toDateString()} · ${sections.length} source file(s)`,
          color: "888888",
          size: 20,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 },
    })
  );

  sections.forEach((section, idx) => {
    // Section heading
    children.push(
      new Paragraph({
        text: `Section ${idx + 1}: ${section.filename}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      })
    );

    // Body lines — split by newline, skip blanks, render as paragraphs
    const lines = section.text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: "[No readable text found]", italics: true, color: "999999" })],
        })
      );
    } else {
      lines.forEach((line) => {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: line, size: 24, font: "Calibri" })],
            spacing: { after: 120 },
          })
        );
      });
    }

    // Page break between sections (except last)
    if (idx < sections.length - 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 24 },
        },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Cloud Function ────────────────────────────────────────────────────────

exports.convertNotes = functions
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    // CORS — allow your GitHub Pages domain and localhost
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      // 1. Parse uploaded files
      const uploads = await parseMultipart(req);

      if (!uploads.length) {
        res.status(400).send("No files received.");
        return;
      }

      // 2. Extract text from each file
      const sections = await Promise.all(
        uploads.map(async ({ filename, buffer }) => {
          const text = await extractText(buffer, filename);
          return { filename, text };
        })
      );

      // 3. Build the .docx
      const docBuffer = await buildDocx(sections);

      // 4. Send back as download
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.set("Content-Disposition", 'attachment; filename="WorkBeta_Document.docx"');
      res.status(200).send(docBuffer);

    } catch (err) {
      console.error("convertNotes error:", err);
      res.status(500).send("Internal error: " + err.message);
    }
  });
