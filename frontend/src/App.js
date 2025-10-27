import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

// Add UUID function at the top
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [role, setRole] = useState('cadre');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadText, setUploadText] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileType, setFileType] = useState('pdf');
  const [imageType, setImageType] = useState('ocr');
  const [startPage, setStartPage] = useState(1);
  const [conversations, setConversations] = useState({});
  const [currentThread, setCurrentThread] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  // New state for RAG toggle
  const [isRagMode, setIsRagMode] = useState(true);
  // Add these to the state declarations
  const [tempImageBase64, setTempImageBase64] = useState(null);
  const [tempMimeType, setTempMimeType] = useState(null);
  // New states for temporary image upload in General Mode
  const [tempImageProcessing, setTempImageProcessing] = useState(false);
  const [showTempImageModal, setShowTempImageModal] = useState(false);
  const [tempImageFile, setTempImageFile] = useState(null);
  const [tempImageType, setTempImageType] = useState('ocr');
  const fileInputRef = useRef(null);

  const API_BASE = 'http://localhost:5000';

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      fetchConversations();
      setIsAuthenticated(true);
    }
  }, []);

  const fetchConversations = async () => {
    try {
      const res = await axios.get(`${API_BASE}/conversations`);
      setConversations(res.data);
    } catch (error) {
      console.error('Error fetching conversations:', error);
    }
  };

  const handleRegister = async () => {
    try {
      const res = await axios.post(`${API_BASE}/register`, {
        first_name: firstName,
        role,
        username,
        password,
      });
      localStorage.setItem('token', res.data.token);
      axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
      setUser(res.data.user);
      setIsAuthenticated(true);
      setShowRegister(false);
      setFirstName('');
      setRole('cadre');
      setUsername('');
      setPassword('');
      fetchConversations();
    } catch (error) {
      console.error('Registration error:', error);
      alert('Registration failed: ' + (error.response ? error.response.data.error : error.message));
    }
  };

  const handleLogin = async () => {
    try {
      const res = await axios.post(`${API_BASE}/login`, {
        username,
        password,
      });
      localStorage.setItem('token', res.data.token);
      axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
      setUser(res.data.user);
      setIsAuthenticated(true);
      setUsername('');
      setPassword('');
      fetchConversations();
    } catch (error) {
      console.error('Login error:', error);
      alert('Login failed: ' + (error.response ? error.response.data.error : error.message));
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    delete axios.defaults.headers.common['Authorization'];
    setIsAuthenticated(false);
    setUser(null);
    setConversations({});
    setCurrentThread(null);
    setIsSidebarOpen(false);
  };

  const handleUpload = async () => {
    if (fileType === 'text' && !uploadText.trim()) {
      return alert('Text required');
    }
    if (fileType !== 'text' && !selectedFile) {
      return alert('File required');
    }

    setUploading(true);
    const formData = new FormData();
    if (fileType !== 'text') {
      formData.append('file', selectedFile);
    }
    if (fileType === 'pdf') {
      formData.append('startPage', startPage);
    }
    if (fileType === 'image') {
      formData.append('imageType', imageType);
    }
    if (fileType === 'text') {
      formData.append('text', uploadText);
    }

    try {
      const endpoint = fileType === 'text' ? '/upload-text' : '/upload-file';
      await axios.post(`${API_BASE}${endpoint}`, fileType === 'text' ? { text: uploadText } : formData, {
        headers: fileType !== 'text' ? { 'Content-Type': 'multipart/form-data' } : {},
      });
      alert(`${fileType.charAt(0).toUpperCase() + fileType.slice(1)} uploaded`);
      setSelectedFile(null);
      setUploadText('');
      setStartPage(1);
      setImageType('ocr');
      setFileType('pdf');
      setShowUploadModal(false);
    } catch (error) {
      alert('Upload failed: ' + (error.response ? error.response.data.error : error.message));
    } finally {
      setUploading(false);
    }
  };

  const handleTempImageProcess = async () => {
    if (!tempImageFile) return;
    
    setTempImageProcessing(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const fullDataUrl = reader.result;
        const base64 = fullDataUrl.split(',')[1]; // Base64 data without prefix
        
        if (tempImageType === 'ocr') {
          // Extract text using OCR
          try {
            const response = await axios.post(`${API_BASE}/process-temp-image-ocr`, {
              image: base64
            });
            const processedText = response.data.text || '';
            
            // Append OCR text to question
            setQuestion(prev => `${prev}\n\nExtracted text from image: ${processedText}`);
            alert('Text extracted from image and added to your question!');
          } catch (backendError) {
            console.warn('Backend OCR failed, trying direct API:', backendError);
            try {
              const EMBEDDINGS_API_BASE = 'http://localhost:8000';
              const response = await axios.post(`${EMBEDDINGS_API_BASE}/ocr`, {
                image: base64
              }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
              const processedText = response.data.text || '';
              
              setQuestion(prev => `${prev}\n\nExtracted text from image: ${processedText}`);
              alert('Text extracted from image and added to your question!');
            } catch (directError) {
              console.error('Direct OCR API failed:', directError);
              alert('Failed to extract text from image: ' + (directError.response?.data?.error || directError.message));
            }
          }
        } else if (tempImageType === 'explain') {
          // Store image for AI analysis
          setTempImageBase64(base64);
          setTempMimeType(tempImageFile.type);
          alert('Image attached! Now ask a question about it — the AI will analyze the image along with your query.');
        }
        
        setShowTempImageModal(false);
        setTempImageFile(null);
      };
      reader.readAsDataURL(tempImageFile);
    } catch (error) {
      console.error('Image processing error:', error);
      alert('Failed to process image: ' + (error.response?.data?.error || error.message));
    } finally {
      setTempImageProcessing(false);
    }
  };

  const handleAsk = async () => {
    if (!question.trim()) return;
    
    setLoading(true);
    const threadId = currentThread || uuidv4();
    if (!currentThread) setCurrentThread(threadId);
    
    const newQA = { question, answer: '', sources: [] };
    setConversations(prev => ({
      ...prev,
      [threadId]: [...(prev[threadId] || []), newQA]
    }));
    
    try {
      const payload = {
        question,
        thread_id: threadId,
        force_general_mode: !isRagMode  // This is the key fix
      };
      
      // Add image if available (only for General mode)
      if (!isRagMode && tempImageBase64 && tempMimeType) {
        payload.image_base64 = tempImageBase64;
        payload.mime_type = tempMimeType;
      }
      
      const res = await axios.post(`${API_BASE}/ask`, payload);
      
      // FIX: Ensure thread exists and has items before accessing
      setConversations(prev => {
        const updatedConversations = { ...prev };
        const thread = updatedConversations[threadId];
        
        if (thread && thread.length > 0) {
          thread[thread.length - 1].answer = res.data.answer;
          thread[thread.length - 1].sources = res.data.sources || [];
        }
        
        return updatedConversations;
      });
      
      // Clear temp image after successful ask
      setTempImageBase64(null);
      setTempMimeType(null);
    } catch (error) {
      // FIX: Same safety check for error handling
      setConversations(prev => {
        const updatedConversations = { ...prev };
        const thread = updatedConversations[threadId];
        
        if (thread && thread.length > 0) {
          thread[thread.length - 1].answer = 'Error: ' + (error.response ? error.response.data.error : error.message);
        }
        
        return updatedConversations;
      });
    } finally {
      setLoading(false);
      setQuestion('');
    }
  };

  const startNewConversation = () => {
    setCurrentThread(null);
  };

  const toggleRagMode = () => {
    setIsRagMode(!isRagMode);
    // Clear any attached image when switching modes
    setTempImageBase64(null);
    setTempMimeType(null);
  };

  const handleTempImageUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type.startsWith('image/')) {
      setTempImageFile(file);
      setShowTempImageModal(true);
    } else {
      alert('Please select a valid image file');
    }
    // Reset the file input
    event.target.value = '';
  };

  return (
    <div className="min-h-screen bg-neutral-50 font-sans text-neutral-800">
      {!isAuthenticated ? (
        <div className="flex items-center justify-center min-h-screen">
          <div className="bg-white p-8 rounded-xl shadow-2xl w-96">
            <h2 className="text-3xl font-bold mb-6 text-center text-teal-600">
              {showRegister ? 'Register' : 'Login'}
            </h2>
            {showRegister && (
              <>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First Name"
                  className="w-full p-3 mb-4 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full p-3 mb-4 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="cadre">Cadre</option>
                  <option value="admin">Admin</option>
                </select>
              </>
            )}
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="w-full p-3 mb-4 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full p-3 mb-6 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <button
              onClick={showRegister ? handleRegister : handleLogin}
              className="w-full bg-teal-600 text-white p-3 rounded-lg font-semibold hover:bg-teal-700 transition-colors"
            >
              {showRegister ? 'Register' : 'Login'}
            </button>
            <p className="mt-6 text-center text-neutral-500">
              {showRegister ? 'Have an account?' : 'Need an account?'}{' '}
              <span
                onClick={() => setShowRegister(!showRegister)}
                className="text-teal-600 font-medium cursor-pointer hover:underline"
              >
                {showRegister ? 'Login' : 'Register'}
              </span>
            </p>
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-screen">
          {/* Sidebar */}
          <div
            className={`fixed inset-y-0 left-0 w-64 bg-white shadow-2xl transform ${
              isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
            } transition-transform duration-300 ease-in-out z-20 md:relative md:translate-x-0 md:shadow-none`}
          >
            <div className="p-6 h-full flex flex-col">
              <h3 className="text-xl font-bold mb-6 text-teal-600">Conversations</h3>
              <div className="flex-1 overflow-y-auto space-y-2">
                {Object.keys(conversations).length === 0 ? (
                  <p className="text-neutral-500 text-sm">No conversations yet.</p>
                ) : (
                  Object.keys(conversations).map((thread) => (
                    <button
                      key={thread}
                      onClick={() => {
                        setCurrentThread(thread);
                        setIsSidebarOpen(false);
                      }}
                      className={`block w-full text-left p-3 rounded-lg transition-colors
                        ${currentThread === thread ? 'bg-neutral-200 text-teal-700' : 'hover:bg-neutral-100'}`}
                    >
                      <span className="text-sm font-medium">
                        {conversations[thread][0]?.question.slice(0, 30) || `New Chat`}...
                      </span>
                    </button>
                  ))
                )}
              </div>
              <button
                onClick={() => {
                  startNewConversation();
                  setIsSidebarOpen(false);
                }}
                className="mt-6 w-full bg-teal-500 text-white font-semibold py-3 rounded-lg shadow-md hover:bg-teal-600 transition-colors"
              >
                New Conversation
              </button>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 p-6 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center">
                <button
                  onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                  className="p-2 text-neutral-600 hover:text-teal-600 md:hidden transition-colors"
                  title={isSidebarOpen ? 'Hide History' : 'Show History'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                </button>
                <div className="md:ml-0">
  <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-teal-500 to-teal-700 tracking-wide">
    HCP Chatbot
  </h1>
  <p className="text-lg font-medium text-neutral-600 mt-1 animate-pulse">
    Hello, <span className="text-teal-600 font-bold">{user?.username || 'User'}</span>! 👋
  </p>
</div>
              </div>
              <button
                onClick={handleLogout}
                className="bg-red-500 text-white font-semibold px-4 py-2 rounded-lg hover:bg-red-600 transition-colors"
              >
                Logout
              </button>
            </div>

            {/* New Floating Answer Mode Button */}
{/* New Floating Answer Mode Button */}
<div className="fixed top-6 right-6 mx-24 my-4 z-10">
  <div className="relative group">
    <button
      onClick={toggleRagMode}
      className={`p-3 rounded-full shadow-lg transition-all duration-300 ease-in-out transform hover:scale-110
      ${isRagMode ? 'bg-teal-600 text-white' : 'bg-violet-600 text-white'}`}
      title={isRagMode ? 'Switch to General Mode' : 'Switch to Document Mode'}
    >
      {isRagMode ? (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m-5 8h4a2 2 0 002-2V6a2 2 0 00-2-2h-4a2 2 0 00-2 2v16a2 2 0 002 2z" />
        </svg>
      ) : (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13.5m0-13.5C10.835 5.578 9.58 5.42 8.322 5.37a2.001 2.001 0 00-1.898 1.63L6 8m6-1.747c1.165-.675 2.42-1.096 3.678-1.298a2.001 2.001 0 011.898 1.63L18 8m-6-1.747c-1.165-.675-2.42-1.096-3.678-1.298a2.001 2.001 0 00-1.898 1.63L6 8" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M16 18h.01M8 18h.01M12 12h.01M16 12h.01M8 12h.01M12 6h.01M16 6h.01M8 6h.01" />
        </svg>
      )}
    </button>
  </div>
</div>

            <div className="bg-white p-6 rounded-xl shadow-md flex-1 flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-neutral-700">Chat</h3>
                <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                  isRagMode
                    ? 'bg-teal-100 text-teal-800'
                    : 'bg-violet-100 text-violet-800'
                }`}>
                  {isRagMode ? 'Document Mode' : 'General Mode'}
                </div>
              </div>

              {/* Show attached image indicator */}
              {!isRagMode && tempImageBase64 && (
                <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-emerald-700">
                      📷 Image attached for AI analysis
                    </span>
                    <button
                      onClick={() => {
                        setTempImageBase64(null);
                        setTempMimeType(null);
                      }}
                      className="text-emerald-700 hover:text-emerald-900 text-sm font-medium"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}

              {/* Conversation History */}
              <div className="flex-1 mb-4 max-h-[60vh] overflow-y-auto space-y-4 pr-2">
                {currentThread && conversations[currentThread] && (
                  <div className="space-y-4">
                    {conversations[currentThread].map((chat, index) => (
                      <div key={index}>
                        {/* User's Message */}
                        <div className="flex justify-end mb-2">
                          <div className="bg-teal-500 text-white p-3 rounded-tl-lg rounded-bl-lg rounded-br-lg max-w-xl shadow-sm">
                            <p className="font-medium">{chat.question}</p>
                          </div>
                        </div>
                        {/* AI's Message */}
                        <div className="flex justify-start">
                          <div className="bg-neutral-100 text-neutral-800 p-3 rounded-tr-lg rounded-bl-lg rounded-br-lg max-w-xl shadow-sm">
                            <p className="font-medium mb-2">{chat.answer}</p>
                            {chat.sources && chat.sources.length > 0 && (
                              <p className="text-xs text-neutral-500 mt-2">
                                Sources: {chat.sources.map((s) => `${s.file} (p. ${s.page})`).join(', ')}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {(!currentThread || !conversations[currentThread]) && (
                  <div className="flex items-center justify-center h-full text-neutral-500">
                    <p className="text-center">Start a new conversation by asking a question below...</p>
                  </div>
                )}
              </div>

              {/* Question Input */}
              <div className="flex items-center gap-3 mt-auto">
                {/* Image upload icon for General Mode only */}
                {!isRagMode && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleTempImageUpload}
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="p-3 text-neutral-500 hover:text-violet-600 hover:bg-neutral-100 rounded-full transition-colors"
                      title="Upload image for analysis"
                      disabled={loading || tempImageProcessing}
                    >
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </button>
                  </>
                )}
                
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={
                    isRagMode
                      ? "Ask a question about your documents..."
                      : "Ask me anything (general conversation)..."
                  }
                  onKeyPress={(e) => e.key === 'Enter' && !loading && handleAsk()}
                  className="flex-1 p-3 border border-neutral-300 rounded-full focus:outline-none focus:ring-2 focus:ring-teal-500 transition-colors"
                />
                <button
                  onClick={handleAsk}
                  disabled={loading || !question.trim()}
                  className="bg-teal-600 hover:bg-teal-700 text-white px-6 py-3 rounded-full shadow-lg disabled:bg-neutral-400 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? 'Thinking...' : 'Ask'}
                </button>
              </div>
            </div>
          </div>

          {/* Floating Upload Button - Only show in RAG mode */}
          {isRagMode && (
            <button
              onClick={() => setShowUploadModal(true)}
              className="fixed bottom-6 right-6 bg-violet-600 my-24 mx-8 text-white p-4 rounded-full shadow-lg hover:bg-violet-700 transition-colors"
              title="Upload Document"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </button>
          )}

          {/* Upload Modal */}
          {showUploadModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30 p-4">
              <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-md">
                <h3 className="text-xl font-bold mb-4 text-neutral-800">Upload Document</h3>
                <select
                  value={fileType}
                  onChange={(e) => setFileType(e.target.value)}
                  className="w-full p-3 border border-neutral-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value="pdf">PDF</option>
                  <option value="image">Image</option>
                  <option value="csv">CSV</option>
                  <option value="excel">Excel</option>
                  <option value="text">Text</option>
                </select>

                {fileType === 'text' && (
                  <textarea
                    value={uploadText}
                    onChange={(e) => setUploadText(e.target.value)}
                    placeholder="Paste your text here..."
                    className="w-full p-3 border border-neutral-300 rounded-lg mb-4 h-32 resize-vertical focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                )}

                {fileType === 'pdf' && (
                  <input
                    type="number"
                    value={startPage}
                    onChange={(e) => setStartPage(Math.max(1, parseInt(e.target.value) || 1))}
                    min="1"
                    placeholder="Start Page"
                    className="w-full p-3 border border-neutral-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                )}

                {fileType === 'image' && (
                  <select
                    value={imageType}
                    onChange={(e) => setImageType(e.target.value)}
                    className="w-full p-3 border border-neutral-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="ocr">Text Image (OCR)</option>
                    <option value="blip">Non-Text Image (Charts/Figures - BLIP Caption)</option>
                  </select>
                )}

                {fileType !== 'text' && (
                  <input
                    type="file"
                    onChange={(e) => setSelectedFile(e.target.files[0])}
                    accept={
                      fileType === 'pdf'
                        ? '.pdf'
                        : fileType === 'image'
                        ? 'image/*'
                        : fileType === 'csv'
                        ? '.csv'
                        : '.xlsx,.xls'
                    }
                    className="mb-4 w-full"
                  />
                )}

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => setShowUploadModal(false)}
                    className="bg-neutral-300 hover:bg-neutral-400 text-neutral-800 font-semibold px-4 py-2 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpload}
                    disabled={uploading || (fileType !== 'text' && !selectedFile) || (fileType === 'text' && !uploadText.trim())}
                    className="bg-violet-600 hover:bg-violet-700 text-white font-semibold px-4 py-2 rounded-lg disabled:bg-neutral-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Temporary Image Processing Modal (General Mode) */}
          {showTempImageModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30 p-4">
              <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-md">
                <h3 className="text-xl font-bold mb-4 text-neutral-800">Process Image</h3>
                <p className="text-sm text-neutral-600 mb-4">
                  This image will be processed temporarily and not saved to the database.
                </p>
                
                {tempImageFile && (
                  <div className="mb-4 p-3 bg-neutral-100 rounded-lg border border-neutral-200">
                    <p className="text-sm font-medium text-neutral-700 mb-1">Selected file:</p>
                    <p className="text-sm text-neutral-600 truncate">{tempImageFile.name}</p>
                  </div>
                )}

                <select
                  value={tempImageType}
                  onChange={(e) => setTempImageType(e.target.value)}
                  className="w-full p-3 border border-neutral-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value="ocr">Extract text (OCR)</option>
                  <option value="explain">Analyze image with AI</option>
                </select>

                <div className="text-sm text-neutral-600 mb-6 p-3 bg-neutral-50 border border-neutral-200 rounded-lg">
                  {tempImageType === 'ocr'
                    ? "Text will be extracted from the image and added to your question."
                    : "The AI will analyze the image along with your question to provide a response."
                  }
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => {
                      setShowTempImageModal(false);
                      setTempImageFile(null);
                    }}
                    className="bg-neutral-300 hover:bg-neutral-400 text-neutral-800 font-semibold px-4 py-2 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleTempImageProcess}
                    disabled={tempImageProcessing}
                    className="bg-teal-600 hover:bg-teal-700 text-white font-semibold px-4 py-2 rounded-lg disabled:bg-neutral-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {tempImageProcessing ? 'Processing...' : 'Process Image'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;