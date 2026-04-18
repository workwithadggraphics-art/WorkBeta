const express = require("express");
const cors = require("cors");
const Busboy = require("busboy");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, AlignmentType
} = require("docx");

const app = express();
app.use(cors());

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
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (["jpg","jpeg","png"].includes(ext)) {
    const { data } = await Tesseract.recognize(buffer, "eng", { logger: () => {} });
    return data.text;
  }
  return `[Unsupported file: ${filename}]`;
}

function buildDocx(sections) {
  const children = [];
  children.push(new Paragraph({
    text: "WorkBeta Compiled Document",
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 }
  }));
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Generated on ${new Date().toDateString()} · ${sections.length} file(s)`,
      color: "888888", size: 20
    })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 800 }
  }));

  sections.forEach((section, idx) => {
    children.push(new Paragraph({
      text: `Section ${idx + 1}: ${section.filename}`,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 }
    }));
    const lines = section.text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) {
      children.push(new Paragraph({
        children: [new TextRun({ text: "[No readable text found]", italics: true, color: "999999" })]
      }));
    } else {
      lines.forEach(line => {
        children.push(new Paragraph({
          children: [new TextRun({ text: line, size: 24, font: "Calibri" })],
          spacing: { after: 120 }
        }));
      });
    }
    if (idx < sections.length - 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 24 } } } },
    sections: [{ children }]
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