const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const axios = require("axios");
const multer = require("multer");
const { JSDOM } = require("jsdom");
const pdfjsLib = require("pdfjs-dist");
const Canvas = require("canvas");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Readable } = require("stream");
const csvParser = require("csv-parser");
const XLSX = require("xlsx");
require("dotenv").config();

// Set up jsdom to provide DOMMatrix
const dom = new JSDOM();
global.DOMMatrix = dom.window.DOMMatrix;
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/build/pdf.worker.min.js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
    if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, images, CSV, and Excel are allowed'), false);
    }
  }
});

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_here";

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access token required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
};

async function initDB() {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        role VARCHAR(50) NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          file_name VARCHAR(255) NOT NULL,
          file_type TEXT NOT NULL,
          file_data BYTEA,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id SERIAL PRIMARY KEY,
        file_id INTEGER REFERENCES files(id),
        chunk_text TEXT NOT NULL,
        source_type TEXT NOT NULL,
        page_number INTEGER,
        processing_method TEXT DEFAULT 'text',
        related_paragraph_id INTEGER,
        embedding vector(384),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS images (
        id SERIAL PRIMARY KEY,
        chunk_id INTEGER REFERENCES chunks(id),
        image_data BYTEA,
        caption TEXT,
        is_chart BOOLEAN DEFAULT FALSE,
        position_info JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        thread_id VARCHAR(36) NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        sources_used JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Database initialization completed");
  } catch (err) {
    console.error("DB init error:", err);
  }
};

// Helper function to group text items into lines
function groupIntoLines(textItems) {
  const lines = [];
  let currentLine = [];
  let lastY = null;
  const yThreshold = 2;

  textItems.sort((a, b) => b.y - a.y || a.x - b.x);

  for (const item of textItems) {
    if (lastY === null || Math.abs(item.y - lastY) <= yThreshold) {
      currentLine.push(item);
    } else {
      if (currentLine.length > 0) {
        lines.push(currentLine.sort((a, b) => a.x - b.x));
      }
      currentLine = [item];
    }
    lastY = item.y;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine.sort((a, b) => a.x - b.x));
  }

  return lines;
}

function processTextItems(textItems) {
  const processedItems = textItems.map(item => ({
    text: item.str.trim(),
    fontSize: item.height || 12,
    x: item.transform[4],
    y: item.transform[5],
    fontName: item.fontName || '',
    isBold: item.fontName ? item.fontName.toLowerCase().includes('bold') : false
  })).filter(item => item.text.length > 0);

  const lines = groupIntoLines(processedItems);
  
  return lines.map(line => {
    const text = line.map(item => item.text).join(' ').trim();
    const maxFontSize = Math.max(...line.map(item => item.fontSize));
    const avgFontSize = line.reduce((sum, item) => sum + item.fontSize, 0) / line.length;
    const hasBold = line.some(item => item.isBold);
    
    const isHeading = (
      (maxFontSize >= 12 || hasBold) && 
      text.length < 150 && 
      text.length > 0 &&
      !text.match(/^\d+\.?\s*$/) && 
      !text.match(/^page\s+\d+/i) && 
      !text.endsWith('.')
    );

    return {
      text,
      isHeading,
      fontSize: maxFontSize,
      avgFontSize,
      hasBold
    };
  }).filter(line => line.text.trim().length > 0);
}

function createChunksFromContent(content, pageNum) {
  const chunks = [];
  let currentChunk = [];
  let currentTokenCount = 0;

  const TARGET_MIN_TOKENS = 400;
  const TARGET_MAX_TOKENS = 500;

  function getTokenCount(text) {
    return text.split(/\s+/).length;
  }

  function createChunk(lines) {
    if (lines.length === 0) return null;

    const chunkText = lines.map(line => line.text).join(' ').trim();
    const tokenCount = getTokenCount(chunkText);

    return {
      text: chunkText,
      type: 'text',
      pageNumber: pageNum,
      processingMethod: 'text',
      tokenCount
    };
  }

  for (const line of content) {
    const lineTokenCount = getTokenCount(line.text);

    if (currentTokenCount + lineTokenCount > TARGET_MAX_TOKENS) {
      const chunk = createChunk(currentChunk);
      if (chunk) chunks.push(chunk);
      currentChunk = [];
      currentTokenCount = 0;
    }

    currentChunk.push(line);
    currentTokenCount += lineTokenCount;

    if (currentTokenCount >= TARGET_MIN_TOKENS) {
      const chunk = createChunk(currentChunk);
      if (chunk) chunks.push(chunk);
      currentChunk = [];
      currentTokenCount = 0;
    }
  }

  if (currentChunk.length > 0) {
    const chunk = createChunk(currentChunk);
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}



// Helper to get embedding
async function getEmbedding(text) {
  const res = await axios.post(process.env.EMBEDDINGS_API_URL, { text });
  return res.data.embedding;
}

// Register user
app.post("/register", async (req, res) => {
  const { first_name, role, username, password } = req.body;
  if (!first_name || !role || !username || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users(first_name, role, username, password_hash) VALUES($1, $2, $3, $4) RETURNING id, first_name, role, username",
      [first_name, role, username, hashedPassword]
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "1h" });

    res.json({ token, user });
  } catch (err) {
    console.error("Register error:", err);
    res.status(400).json({ error: "Username already exists or invalid data" });
  }
});

// Login user
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user: { id: user.id, first_name: user.first_name, role: user.role, username: user.username } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Upload text handler
app.post("/upload-text", authenticateToken, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "Text required" });

  try {
    const fileId = await pool.query(
      "INSERT INTO files(user_id, file_name, file_type) VALUES($1, $2, $3) RETURNING id",
      [req.user.id, `text_${Date.now()}.txt`, "text/plain"]
    ).then(res => res.rows[0].id);

    const embedding = await getEmbedding(text);
    await pool.query(
      "INSERT INTO chunks(file_id, chunk_text, source_type, processing_method, embedding) VALUES($1, $2, $3, $4, $5)",
      [fileId, text, "text", "text", `[${embedding.join(',')}]`]
    );

    res.json({ message: "Text uploaded and processed successfully" });
  } catch (err) {
    console.error("Upload text error:", err);
    res.status(500).json({ error: "Failed to process text" });
  }
});

// Updated PDF processing section in upload handler
app.post("/upload-file", authenticateToken, upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "File required" });

  const fileId = await pool.query(
    "INSERT INTO files(user_id, file_name, file_type, file_data) VALUES($1, $2, $3, $4) RETURNING id",
    [req.user.id, file.originalname, file.mimetype, file.buffer]
  ).then(res => res.rows[0].id);

  try {
    if (file.mimetype === 'application/pdf') {
      const startPage = parseInt(req.body.startPage) || 1;
      // Convert Buffer to Uint8Array
      const pdfData = new Uint8Array(file.buffer);
      const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
      const numPages = pdf.numPages;

      console.log(`Processing PDF: ${file.originalname} (${numPages} pages, starting from page ${startPage})`);

      for (let pageNum = startPage; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        
        // Only extract text content - ignore images
        const content = await page.getTextContent();
        
        if (content.items.length === 0) {
          console.log(`Page ${pageNum}: No text content found, skipping`);
          continue;
        }
        
        const textItems = processTextItems(content.items);
        const chunks = createChunksFromContent(textItems, pageNum);

        console.log(`Page ${pageNum}: Created ${chunks.length} chunks`);

        for (const chunk of chunks) {
          const embedding = await getEmbedding(chunk.text);
          await pool.query(
            "INSERT INTO chunks(file_id, chunk_text, source_type, page_number, processing_method, embedding) VALUES($1, $2, $3, $4, $5, $6)",
            [fileId, chunk.text, 'pdf', chunk.pageNumber, `text_${chunk.wordCount}w`, `[${embedding.join(',')}]`]
          );
        }
      }
      
      console.log(`PDF processing completed for: ${file.originalname}`);
      
    } else if (file.mimetype.startsWith('image/')) {
      // Image processing remains unchanged
      const imageType = req.body.imageType || 'ocr';
      const imageBuffer = await sharp(file.buffer).png().toBuffer();
      const base64Image = imageBuffer.toString('base64');
      let processRes;
      let method;

      if (imageType === 'ocr') {
        processRes = await axios.post(`${process.env.EMBEDDINGS_API_URL.replace('/embed', '/ocr')}`, { image: base64Image });
        method = 'ocr';
      } else if (imageType === 'blip') {
        processRes = await axios.post(`${process.env.EMBEDDINGS_API_URL.replace('/embed', '/generate-caption')}`, { image: base64Image });
        method = 'blip';
      } else {
        return res.status(400).json({ error: "Invalid imageType" });
      }

      const text = processRes.data.text || processRes.data.caption;
      if (!text.trim()) return res.status(400).json({ error: "No content extracted from image" });

      const embedding = await getEmbedding(text);
      await pool.query(
        "INSERT INTO chunks(file_id, chunk_text, source_type, processing_method, embedding) VALUES($1, $2, $3, $4, $5)",
        [fileId, text, 'image', method, `[${embedding.join(',')}]`]
      );
      
    } else if (file.mimetype === 'text/csv') {
      // CSV processing remains unchanged
      const rows = [];
      const stream = Readable.from(file.buffer).pipe(csvParser());

      await new Promise((resolve, reject) => {
        stream.on('data', (row) => rows.push(row));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const chunkText = JSON.stringify(row);
        const embedding = await getEmbedding(chunkText);
        await pool.query(
          "INSERT INTO chunks(file_id, chunk_text, source_type, page_number, processing_method, embedding) VALUES($1, $2, $3, $4, $5, $6)",
          [fileId, chunkText, 'csv', i + 1, 'text', `[${embedding.join(',')}]`]
        );
      }
      
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.mimetype === 'application/vnd.ms-excel') {
      // Excel processing remains unchanged
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const chunkText = JSON.stringify(row);
        const embedding = await getEmbedding(chunkText);
        await pool.query(
          "INSERT INTO chunks(file_id, chunk_text, source_type, page_number, processing_method, embedding) VALUES($1, $2, $3, $4, $5, $6)",
          [fileId, chunkText, 'excel', i + 1, 'text', `[${embedding.join(',')}]`]
        );
      }
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    res.json({ message: "File uploaded and processed successfully" });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to process file" });
  }
});

// Modified search helper with admin priority
async function searchWithPriority(question, vectorString, userId) {
  // First, search in admin-uploaded files (role = 'admin' OR 'administrator')
  const adminResults = await pool.query(
    `SELECT c.chunk_text, c.source_type, c.page_number, c.processing_method, f.file_name,
            1 - (c.embedding <=> $1::vector) as similarity
     FROM chunks c 
     JOIN files f ON c.file_id = f.id 
     JOIN users u ON f.user_id = u.id
     WHERE (u.role = 'admin' OR u.role = 'administrator')
     AND 1 - (c.embedding <=> $1::vector) > 0.15 
     ORDER BY similarity DESC 
     LIMIT 5`,
    [vectorString]
  );

  if (adminResults.rows.length > 0) {
    console.log('Using admin-shared results');
    return {
      results: adminResults.rows,
      sources: adminResults.rows.map(r => ({
        file: r.file_name,
        page: r.page_number,
        type: r.source_type,
        method: r.processing_method,
        from: 'admin'
      }))
    };
  }

  // If no admin results, search in current user's files
  const userResults = await pool.query(
    `SELECT c.chunk_text, c.source_type, c.page_number, c.processing_method, f.file_name,
            1 - (c.embedding <=> $1::vector) as similarity
     FROM chunks c 
     JOIN files f ON c.file_id = f.id 
     WHERE f.user_id = $2
     AND 1 - (c.embedding <=> $1::vector) > 0.15 
     ORDER BY similarity DESC 
     LIMIT 5`,
    [vectorString, userId]
  );

  if (userResults.rows.length > 0) {
    console.log('Using user-specific results');
    return {
      results: userResults.rows,
      sources: userResults.rows.map(r => ({
        file: r.file_name,
        page: r.page_number,
        type: r.source_type,
        method: r.processing_method,
        from: 'user'
      }))
    };
  }

  // No results from either
  return { results: [], sources: [] };
}

// Function to generate answer using Gemini
async function generateGeminiAnswer(question, context = null, isGeneralChat = false, imageBase64 = null, mimeType = null) {
  let prompt;
  let parts = [];

  if (isGeneralChat) {
    // For general conversation with optional image support
    prompt = `You are a helpful and friendly AI assistant. Answer the following question in a natural, conversational manner. Be informative but concise, and maintain a professional yet warm tone.

Question: ${question}

Guidelines:
- Provide helpful and accurate information
- Keep responses clear and well-structured
- If you're not certain about something, acknowledge the limitation
- Be conversational but professional
- Aim for 2-4 sentences unless the question requires more detail
- If an image is provided, analyze it to assist with your answer`;

    // Add text part
    parts.push({ text: prompt });

    // Add image part if provided
    if (imageBase64 && mimeType) {
      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: imageBase64
        }
      });
    }
  } else {
    // For document-based questions
    prompt = `You are a professional assistant helping with document-based inquiries. Answer the question using ONLY the information provided in the context below. 

Context from documents:
${context || "No context provided"}

Question: ${question}

Instructions:
- Base your answer strictly on the provided context
- If the context doesn't contain sufficient information to fully answer the question, clearly state this
- Be precise and professional
- Structure your response clearly
- If you reference specific information, you may mention it comes from the provided documents
- Do not make assumptions beyond what's stated in the context`;

    // Add text part only (no image support in document mode)
    parts.push({ text: prompt });
  }

  try {
    const geminiRes = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent",
      {
        contents: [{
          parts: parts
        }],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        }
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        timeout: 30000
      }
    );
    
    return geminiRes.data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("Gemini API error:", error);
    
    if (isGeneralChat) {
      return "I apologize, but I'm having trouble processing your question right now. Could you please try rephrasing it or ask something else?";
    } else {
      return "I'm sorry, I'm experiencing technical difficulties while processing the document information. Please try your question again.";
    }
  }
}
app.post("/ask", authenticateToken, async (req, res) => {
  const { question, thread_id: input_thread_id, force_general_mode, image_base64, mime_type } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "Question required" });
  
  const thread_id = input_thread_id || uuidv4();
  
  try {
    console.log(`Processing question: ${question}`);
    console.log(`Force general mode: ${force_general_mode}`);
    console.log(`Image provided: ${!!image_base64}`);

    // Check if this is a casual greeting or general conversation
    const casualPatterns = [
      /^(hi|hello|hey|greetings?|good\s+(morning|afternoon|evening)|howdy)[\s\.,!?]*$/i,
      /^how\s+are\s+you[\s\.,!?]*$/i,
      /^what'?s\s+up[\s\.,!?]*$/i,
      /^nice\s+to\s+meet\s+you[\s\.,!?]*$/i,
      /^thank\s+you|thanks[\s\.,!?]*$/i,
      /^bye|goodbye|see\s+you[\s\.,!?]*$/i
    ];
    
    const isCasualGreeting = casualPatterns.some(pattern => pattern.test(question.trim()));
    
    // For casual greetings, respond directly without document search
    if (isCasualGreeting && !force_general_mode) {
      let casualResponse;
      const lowerQuestion = question.toLowerCase().trim();
      
      // Get user info for personalized response
      let userName = 'there';
      try {
        const userResult = await pool.query("SELECT first_name FROM users WHERE id = $1", [req.user.id]);
        if (userResult.rows.length > 0 && userResult.rows[0].first_name) {
          userName = userResult.rows[0].first_name;
        }
      } catch (userErr) {
        console.log('Could not fetch user name:', userErr.message);
      }
      
      if (lowerQuestion.match(/^(hi|hello|hey|greetings?)/)) {
        casualResponse = `Hello ${userName}! I'm your  assistant. I can help you with questions about your uploaded documents or have a general conversation. How can I assist you today?`;
      } else if (lowerQuestion.match(/^how\s+are\s+you/)) {
        casualResponse = "I'm doing well, thank you for asking! I'm here and ready to help you with any questions you might have about your documents or anything else. What can I help you with?";
      } else if (lowerQuestion.match(/^what'?s\s+up/)) {
        casualResponse = "Not much, just here waiting to help you! Feel free to ask me anything about your documents or start a conversation about any topic you're interested in.";
      } else if (lowerQuestion.match(/^(thank|thanks)/)) {
        casualResponse = "You're very welcome! I'm always happy to help. Is there anything else you'd like to know or discuss?";
      } else if (lowerQuestion.match(/^(bye|goodbye|see\s+you)/)) {
        casualResponse = "Goodbye! It was great chatting with you. Feel free to come back anytime if you need help with your documents or have any questions!";
      } else {
        casualResponse = "Nice to meet you too! I'm here to help with any questions about your documents or to have a friendly conversation. What would you like to talk about?";
      }
      
      // Save casual conversation
      await pool.query(
        "INSERT INTO conversations(user_id, thread_id, question, answer, sources_used) VALUES($1, $2, $3, $4, $5)",
        [req.user.id, thread_id, question, casualResponse, JSON.stringify([])]
      );
      
      return res.json({ 
        answer: casualResponse, 
        thread_id, 
        sources: [],
        type: 'casual_conversation'
      });
    }
    
    // Determine mode: force_general_mode overrides, otherwise default to RAG unless no relevant docs
    const isGeneralMode = force_general_mode || false;
    
    let answer;
    let sources = [];
    let responseType;

    if (isGeneralMode) {
      console.log('General mode enabled - skipping document search');
      answer = await generateGeminiAnswer(question, null, true, image_base64, mime_type);
      
      // Save conversation
      await pool.query(
        "INSERT INTO conversations(user_id, thread_id, question, answer, sources_used) VALUES($1, $2, $3, $4, $5)",
        [req.user.id, thread_id, question, answer, JSON.stringify([])]
      );
      
      return res.json({ 
        answer, 
        thread_id, 
        sources: [],
        type: 'general_knowledge_forced'
      });
    }
    
    // For non-casual questions in RAG mode, try document search first
    const embedRes = await axios.post(process.env.EMBEDDINGS_API_URL, { 
      text: question 
    });
    const vectorString = `[${embedRes.data.embedding.join(',')}]`;

    // Search with admin priority
    const searchResult = await searchWithPriority(question, vectorString, req.user.id);
    
    if (searchResult.results.length === 0) {
      console.log('No relevant documents found, checking if general knowledge question');
      
      const documentQuestionPatterns = [
        /what\s+(is|are|does|do|can|should|will|would|could|might)\s+.*(policy|procedure|process|guideline|protocol|requirement|standard|rule|regulation|form|document)/i,
        /how\s+(do|can|should|to)\s+.*(apply|submit|complete|fill|process|handle|manage|report)/i,
        /where\s+(is|are|can|do|should)\s+.*(find|get|obtain|access|locate|submit)/i,
        /when\s+(is|are|should|do|can|will)\s+.*(due|required|needed|submitted|processed)/i,
        /who\s+(is|are|can|should|do|will)\s+.*(responsible|contact|handle|process|approve)/i,
        /\b(deadline|due date|timeline|schedule|steps|requirements|eligibility|criteria|qualification)\b/i
      ];
      
      const seemsLikeDocumentQuestion = documentQuestionPatterns.some(pattern => 
        pattern.test(question)
      );
      
      if (seemsLikeDocumentQuestion) {
        answer = "I apologize, but I couldn't find specific information about your question in the available documents. This seems like something that might be covered in your organizational policies or procedures. You might want to:\n\n• Check if you have the relevant documents uploaded\n• Contact your supervisor or HR department\n• Refer to your organization's official policy documents\n• Consider switching to General Mode using the toggle above if you want a general knowledge answer\n\nIs there anything else I can help you with, or would you like to upload additional documents?";
        responseType = 'no_documents_found';
      } else {
        console.log('Treating as general knowledge question');
        answer = await generateGeminiAnswer(question, null, true, image_base64, mime_type);
        responseType = 'general_knowledge';
      }
      sources = [];
    } else {
      console.log(`Found ${searchResult.results.length} relevant chunks from documents`);
      const relevantTexts = searchResult.results
        .map(row => `${row.chunk_text}`)
        .join("\n\n");
      
      answer = await generateGeminiAnswer(question, relevantTexts, false);
      sources = searchResult.sources.slice(0, 3);
      responseType = 'document_based';
    }
    
    // Save conversation
    await pool.query(
      "INSERT INTO conversations(user_id, thread_id, question, answer, sources_used) VALUES($1, $2, $3, $4, $5)",
      [req.user.id, thread_id, question, answer, JSON.stringify(sources)]
    );
    
    res.json({ 
      answer, 
      thread_id, 
      sources: sources,
      type: responseType
    });
    
  } catch (err) {
    console.error("Ask error:", err);
    let errorMessage = "I apologize, but I'm experiencing some technical difficulties right now. Please try again in a moment.";

    if (err.response) {
      if (err.response.status === 429) {
        errorMessage = "I'm currently experiencing high demand. Please wait a moment and try your question again.";
      } else if (err.response.status >= 500) {
        errorMessage = "I'm having trouble with my processing systems right now. Please try again shortly.";
      }
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      errorMessage = "I'm having trouble connecting to my knowledge systems. Please check your connection and try again.";
    } else if (err.code === 'ETIMEDOUT') {
      errorMessage = "The request is taking longer than expected. Please try again with a shorter question.";
    }
    
    try {
      await pool.query(
        "INSERT INTO conversations(user_id, thread_id, question, answer, sources_used) VALUES($1, $2, $3, $4, $5)",
        [req.user.id, thread_id, question, errorMessage, JSON.stringify([])]
      );
    } catch (dbErr) {
      console.error("Error saving error conversation:", dbErr);
    }
    
    res.status(500).json({ error: errorMessage });
  }
});


// Temporary image processing routes (no database storage)
app.post("/process-temp-image-ocr", authenticateToken, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "Image data required" });

  try {
    console.log('Processing temporary image with OCR...');
    const response = await axios.post(`${process.env.EMBEDDINGS_API_URL.replace('/embed', '/ocr')}`, {
      image: image
    }, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const text = response.data.text || '';
    console.log('OCR result:', text.substring(0, 100) + '...');

    res.json({
      text: text.trim() || 'No text found in image',
      method: 'ocr',
      temporary: true
    });

  } catch (error) {
    console.error('Temporary OCR processing error:', error.message);
    res.status(500).json({ 
      error: `OCR processing failed: ${error.response?.data?.error || error.message}` 
    });
  }
});

app.post("/process-temp-image-caption", authenticateToken, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "Image data required" });

  try {
    console.log('Processing temporary image with BLIP captioning...');
    const response = await axios.post(`${process.env.EMBEDDINGS_API_URL.replace('/embed', '/generate-caption')}`, {
      image: image
    }, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const caption = response.data.caption || '';
    console.log('Caption result:', caption);

    res.json({
      caption: caption.trim() || 'Unable to generate caption for image',
      method: 'blip',
      temporary: true
    });

  } catch (error) {
    console.error('Temporary caption processing error:', error.message);
    res.status(500).json({ 
      error: `Caption generation failed: ${error.response?.data?.error || error.message}` 
    });
  }
});

// Health check endpoint to verify embeddings API connection
app.get("/check-embeddings-api", authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(`${process.env.EMBEDDINGS_API_URL.replace('/embed', '/health')}`, {
      timeout: 5000
    });
    res.json({
      status: 'connected',
      embeddings_api_status: response.data
    });
  } catch (error) {
    res.status(500).json({
      status: 'disconnected',
      error: error.message,
      embeddings_api_url: process.env.EMBEDDINGS_API_URL
    });
  }
});

app.get("/conversations", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT thread_id, question, answer, sources_used, created_at 
       FROM conversations 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    
    const grouped = result.rows.reduce((acc, row) => {
      if (!acc[row.thread_id]) {
        acc[row.thread_id] = [];
      }
      acc[row.thread_id].push({ 
        question: row.question, 
        answer: row.answer,
        sources: row.sources_used || [],
        timestamp: row.created_at
      });
      return acc;
    }, {});
    
    res.json(grouped);
  } catch (err) {
    console.error("Conversations error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// Get user's uploaded files
app.get("/files", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, file_name, file_type, created_at FROM files WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Files error:", err);
    res.status(500).json({ error: "Failed to fetch files" });
  }
});

// Delete a file and its chunks
app.delete("/files/:fileId", authenticateToken, async (req, res) => {
  const { fileId } = req.params;
  
  try {
    // Verify file belongs to user
    const fileResult = await pool.query(
      "SELECT id FROM files WHERE id = $1 AND user_id = $2",
      [fileId, req.user.id]
    );
    
    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: "File not found" });
    }
    
    // Delete in correct order due to foreign keys
    await pool.query("DELETE FROM images WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = $1)", [fileId]);
    await pool.query("DELETE FROM chunks WHERE file_id = $1", [fileId]);
    await pool.query("DELETE FROM files WHERE id = $1", [fileId]);
    
    res.json({ message: "File deleted successfully" });
  } catch (err) {
    console.error("Delete file error:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Enhanced RAG Chatbot Server Started');
  console.log('Features:');
  console.log('- Proper PDF chunking based on font size');
  console.log('- Image extraction from PDFs');
  console.log('- BLIP image captioning');
  console.log('- Priority search (admin files first, then user files)');
  console.log('- Enhanced standalone image processing with OCR/BLIP options');
  console.log('- CSV and Excel row-based chunking');
  console.log('- General conversation capability when no documents match');
});
initDB();
