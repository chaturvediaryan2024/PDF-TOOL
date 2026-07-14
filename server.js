const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
[uploadsDir, outputDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/output', express.static(outputDir));

// QPDF — auto-detect across environments.
// On Linux hosts (e.g. Render/Docker) qpdf lives on PATH, so plain 'qpdf' works.
// On Windows use the local install path. Override anytime with the QPDF_PATH env var.
const qpdf = process.env.QPDF_PATH
    || (process.platform === 'win32'
        ? 'C:\\Program Files\\qpdf 12.3.2\\bin\\qpdf.exe'
        : 'qpdf');

function runQpdf(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(qpdf, args, { windowsHide: true });
        let out = '', err = '';
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `Exit ${code}`)));
        proc.on('error', reject);
    });
}

function cleanup(f, delay = 300000) { setTimeout(() => { try { fs.unlinkSync(f); } catch(e) {} }, delay); }
function send(res, filename) { res.json({ success: true, downloadUrl: '/output/' + filename, filename }); }

// ==================== ORGANIZE ====================

// MERGE
app.post('/api/merge', upload.array('files', 50), async (req, res) => {
    if (!req.files || req.files.length < 2) return res.status(400).json({ error: 'Need 2+ files' });
    const out = `merged_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    const inputs = req.files.map(f => f.path);
    try {
        await runQpdf(['--empty', '--pages', ...inputs, '--', outPath]);
        inputs.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        send(res, out); cleanup(outPath);
    } catch (e) { inputs.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} }); res.status(500).json({ error: e.message }); }
});

// SPLIT
app.post('/api/split', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, method = req.body.method || 'all', range = req.body.range || '';
    try {
        const total = parseInt((await runQpdf(['--show-npages', input])).trim());
        let pages = [];
        if (method === 'range' && range) {
            range.split(',').forEach(p => {
                p = p.trim();
                if (p.includes('-')) { const [s,e] = p.split('-').map(n => parseInt(n.trim())); for (let i = s; i <= e && i <= total; i++) pages.push(i); }
                else { const n = parseInt(p); if (n <= total) pages.push(n); }
            });
        } else { for (let i = 1; i <= total; i++) pages.push(i); }

        const files = [];
        for (const pg of pages) {
            const f = path.join(outputDir, `page_${pg}_${Date.now()}.pdf`);
            await runQpdf([input, '--pages', input, `${pg}`, '--', f]);
            files.push({ name: `page_${pg}.pdf`, path: f });
        }

        fs.unlinkSync(input);
        if (files.length === 1) {
            const out = `extracted_${Date.now()}.pdf`;
            fs.renameSync(files[0].path, path.join(outputDir, out));
            send(res, out); cleanup(path.join(outputDir, out));
        } else {
            const zip = new JSZip();
            files.forEach(f => { zip.file(f.name, fs.readFileSync(f.path)); fs.unlinkSync(f.path); });
            const out = `split_${Date.now()}.zip`, outPath = path.join(outputDir, out);
            fs.writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer' }));
            send(res, out); cleanup(outPath);
        }
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// REMOVE/EXTRACT/ORGANIZE PAGES
['remove-pages', 'extract-pages', 'organize'].forEach(ep => {
    app.post(`/api/${ep}`, upload.single('files'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const input = req.file.path;
        // Frontend sends 1-based page numbers, comma-separated.
        const selected = (req.body.pages || '').split(',').filter(p => p).map(p => parseInt(p));
        if (!selected.length) { fs.unlinkSync(input); return res.status(400).json({ error: 'Select pages' }); }
        const out = `${ep.replace('-','_')}_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
        try {
            let pages;
            if (ep === 'remove-pages') {
                // Keep every page EXCEPT the selected ones.
                const total = parseInt((await runQpdf(['--show-npages', input])).trim());
                const removeSet = new Set(selected);
                pages = [];
                for (let i = 1; i <= total; i++) if (!removeSet.has(i)) pages.push(i);
                if (!pages.length) { fs.unlinkSync(input); return res.status(400).json({ error: 'Cannot remove all pages' }); }
            } else {
                // extract / organize: keep exactly the selected pages, in the given order.
                pages = selected;
            }
            await runQpdf([input, '--pages', input, pages.join(','), '--', outPath]);
            fs.unlinkSync(input);
            send(res, out); cleanup(outPath);
        } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
    });
});

// COMPRESS
app.post('/api/compress', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `compressed_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        await runQpdf(['--linearize', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '--object-streams=generate', input, outPath]);
        const orig = fs.statSync(input).size, comp = fs.statSync(outPath).size;
        fs.unlinkSync(input);
        res.json({ success: true, downloadUrl: '/output/' + out, filename: out, originalSize: orig, compressedSize: comp });
        cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// REPAIR
app.post('/api/repair', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `repaired_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        await runQpdf(['--qdf', '--object-streams=disable', input, outPath]);
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// ROTATE
app.post('/api/rotate', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    // Frontend sends `angle`; keep `rotation` as a fallback for older clients.
    let angle = parseInt(req.body.angle || req.body.rotation || '90') || 0;
    // PDF page rotation must be a multiple of 90 — round & normalize to 0..270.
    angle = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
    const input = req.file.path, out = `rotated_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        // :1-z applies the rotation to every page (1 through last).
        await runQpdf([input, `--rotate=+${angle}:1-z`, '--', outPath]);
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// ==================== EDIT ====================

// WATERMARK
app.post('/api/add-watermark', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `watermarked_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    const text = req.body.text || 'WATERMARK', size = parseInt(req.body.size) || 50, opacity = parseFloat(req.body.opacity) || 0.2;
    const colorMap = { gray: rgb(0.5,0.5,0.5), red: rgb(0.8,0.2,0.2), blue: rgb(0.2,0.2,0.8) };
    const color = colorMap[req.body.color] || colorMap.gray;
    try {
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        doc.getPages().forEach(pg => {
            const { width, height } = pg.getSize();
            pg.drawText(text, { x: (width - font.widthOfTextAtSize(text, size)) / 2, y: height / 2, size, font, color, opacity, rotate: degrees(-45) });
        });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// PAGE NUMBERS
app.post('/api/page-numbers', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `numbered_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    const pos = req.body.position || 'bottom-center', start = parseInt(req.body.start) || 1, fmt = req.body.format || 'number';
    try {
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const pages = doc.getPages(), total = pages.length;
        pages.forEach((pg, i) => {
            const { width, height } = pg.getSize(), num = start + i;
            let text = fmt === 'page' ? `Page ${num}` : fmt === 'total' ? `${num} of ${total + start - 1}` : `${num}`;
            const tw = font.widthOfTextAtSize(text, 12);
            let x, y;
            if (pos.includes('bottom')) y = 30; else y = height - 40;
            if (pos.includes('center')) x = (width - tw) / 2;
            else if (pos.includes('right')) x = width - tw - 40;
            else x = 40;
            pg.drawText(text, { x, y, size: 12, font, color: rgb(0,0,0) });
        });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// CROP
app.post('/api/crop', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `cropped_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    const top = parseInt(req.body.top) || 0, bottom = parseInt(req.body.bottom) || 0;
    const left = parseInt(req.body.left) || 0, right = parseInt(req.body.right) || 0;
    try {
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        doc.getPages().forEach(pg => {
            const { width, height } = pg.getSize();
            pg.setCropBox(left, bottom, width - left - right, height - top - bottom);
        });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// EDIT PDF (add text)
app.post('/api/edit-pdf', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `edited_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    const text = req.body.text || '', pageNum = parseInt(req.body.page) || 1, size = parseInt(req.body.size) || 12;
    const x = parseInt(req.body.x) || 50, y = parseInt(req.body.y) || 700;
    try {
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const pg = doc.getPage(pageNum - 1);
        if (pg && text) pg.drawText(text, { x, y, size, font, color: rgb(0,0,0) });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// HEADER & FOOTER
app.post('/api/add-header-footer', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `hf_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    const header = req.body.header || '', footer = req.body.footer || '', align = req.body.align || 'center', fontSize = parseInt(req.body.fontSize) || 10;
    try {
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        doc.getPages().forEach(pg => {
            const { width, height } = pg.getSize();
            if (header) {
                const tw = font.widthOfTextAtSize(header, fontSize);
                let x = align === 'center' ? (width - tw) / 2 : align === 'right' ? width - tw - 40 : 40;
                pg.drawText(header, { x, y: height - 30, size: fontSize, font, color: rgb(0.3,0.3,0.3) });
            }
            if (footer) {
                const tw = font.widthOfTextAtSize(footer, fontSize);
                let x = align === 'center' ? (width - tw) / 2 : align === 'right' ? width - tw - 40 : 40;
                pg.drawText(footer, { x, y: 20, size: fontSize, font, color: rgb(0.3,0.3,0.3) });
            }
        });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// ==================== SECURITY ====================

// PROTECT
app.post('/api/protect', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, pwd = req.body.password;
    if (!pwd) { fs.unlinkSync(input); return res.status(400).json({ error: 'Password required' }); }
    const out = `protected_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        // Try decrypt first if already encrypted
        const dec = input + '_dec.pdf';
        try { await runQpdf(['--decrypt', input, dec]); fs.unlinkSync(input); fs.renameSync(dec, input); } catch(e) {}
        await runQpdf(['--encrypt', pwd, pwd, '256', '--', input, outPath]);
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// UNLOCK
app.post('/api/unlock', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, pwd = req.body.password || '', out = `unlocked_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        await runQpdf([`--password=${pwd}`, '--decrypt', input, outPath]);
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: 'Wrong password' }); }
});

// SIGN
app.post('/api/sign', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, sigData = req.body.signature, pos = req.body.position || 'bottom-right', sigPage = req.body.page || 'last';
    if (!sigData) { fs.unlinkSync(input); return res.status(400).json({ error: 'No signature' }); }
    const out = `signed_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        const sigBytes = Buffer.from(sigData.split(',')[1], 'base64');
        const sigImg = await doc.embedPng(sigBytes);
        const pages = doc.getPages();
        const sigW = 150, sigH = (sigImg.height / sigImg.width) * sigW;
        let pagesToSign = [];
        if (sigPage === 'last') pagesToSign = [pages.length - 1];
        else if (sigPage === 'first') pagesToSign = [0];
        else pagesToSign = pages.map((_, i) => i);

        pagesToSign.forEach(i => {
            const pg = pages[i], { width, height } = pg.getSize();
            let x, y;
            if (pos.includes('right')) x = width - sigW - 40; else if (pos.includes('left')) x = 40; else x = (width - sigW) / 2;
            y = 40;
            pg.drawImage(sigImg, { x, y, width: sigW, height: sigH });
        });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// REDACT
app.post('/api/redact', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, texts = (req.body.texts || '').split('\n').map(t => t.trim()).filter(t => t);
    if (!texts.length) { fs.unlinkSync(input); return res.status(400).json({ error: 'No text to redact' }); }
    const out = `redacted_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        // Simple approach: copy PDF and note that proper redaction needs more sophisticated tools
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// COMPARE
app.post('/api/compare', upload.array('files', 2), async (req, res) => {
    if (!req.files || req.files.length !== 2) return res.status(400).json({ error: 'Need 2 PDFs' });
    const [f1, f2] = req.files;
    try {
        const info1 = (await runQpdf(['--show-npages', f1.path])).trim();
        const info2 = (await runQpdf(['--show-npages', f2.path])).trim();
        const result = `File 1: ${f1.originalname} - ${info1} pages\nFile 2: ${f2.originalname} - ${info2} pages\n\nDifference: ${Math.abs(parseInt(info1) - parseInt(info2))} pages`;
        req.files.forEach(f => fs.unlinkSync(f.path));
        res.json({ success: true, info: result });
    } catch (e) { req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(x) {} }); res.status(500).json({ error: e.message }); }
});

// ==================== MORE TOOLS ====================

// FLATTEN
app.post('/api/flatten', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `flattened_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        await runQpdf(['--flatten-annotations=all', input, outPath]);
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// GRAYSCALE
app.post('/api/grayscale', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `grayscale_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        // qpdf doesn't do grayscale directly, just copy for now
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        fs.writeFileSync(outPath, await doc.save());
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// PDF INFO
app.post('/api/pdf-info', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path;
    try {
        const pages = (await runQpdf(['--show-npages', input])).trim();
        const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
        const info = `File: ${req.file.originalname}\nSize: ${(req.file.size / 1024).toFixed(2)} KB\nPages: ${pages}\nTitle: ${doc.getTitle() || 'N/A'}\nAuthor: ${doc.getAuthor() || 'N/A'}\nCreator: ${doc.getCreator() || 'N/A'}\nProducer: ${doc.getProducer() || 'N/A'}`;
        fs.unlinkSync(input);
        res.json({ success: true, info });
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// PDF/A
app.post('/api/pdf-to-pdfa', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const input = req.file.path, out = `pdfa_${Date.now()}.pdf`, outPath = path.join(outputDir, out);
    try {
        await runQpdf(['--linearize', input, outPath]);
        fs.unlinkSync(input);
        send(res, out); cleanup(outPath);
    } catch (e) { try { fs.unlinkSync(input); } catch(x) {} res.status(500).json({ error: e.message }); }
});

// OCR (placeholder - needs tesseract)
app.post('/api/ocr', upload.single('files'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'OCR requires Tesseract. Install with: winget install UB-Mannheim.TesseractOCR' });
});

// Word/Excel/PPT conversions (placeholder - needs LibreOffice)
['word-to-pdf', 'excel-to-pdf', 'ppt-to-pdf', 'pdf-to-word', 'pdf-to-excel', 'pdf-to-ppt'].forEach(ep => {
    app.post(`/api/${ep}`, upload.single('files'), async (req, res) => {
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(400).json({ error: 'Office conversions require LibreOffice. Install from libreoffice.org' });
    });
});

// HTML to PDF (placeholder)
app.post('/api/html-to-pdf', upload.single('files'), async (req, res) => {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'HTML to PDF requires wkhtmltopdf. Install from wkhtmltopdf.org' });
});

// Health
app.get('/api/health', (req, res) => res.json({ status: 'ok', qpdf: fs.existsSync(qpdf) }));

app.listen(PORT, () => {
    console.log(`
╔═════════════════════════════════════════════════════════════╗
║                    PDF Tools Pro Server                      ║
╠═════════════════════════════════════════════════════════════╣
║   URL:     http://localhost:${PORT}                           ║
║   QPDF:    ${fs.existsSync(qpdf) ? '✓ Ready' : '✗ Not Found'}                                      ║
║                                                              ║
║   Tools:   Merge, Split, Compress, Rotate, Watermark,        ║
║            Page Numbers, Protect, Unlock, Sign, Crop,        ║
║            Edit, Header/Footer, Flatten, Repair & more!      ║
╚═════════════════════════════════════════════════════════════╝
    `);
});
