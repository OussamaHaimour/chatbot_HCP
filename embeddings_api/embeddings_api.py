from flask import Flask, request, jsonify
from flask_cors import CORS
from sentence_transformers import SentenceTransformer
import pytesseract
from PIL import Image
import io
import base64
import torch
from transformers import BlipProcessor, BlipForConditionalGeneration
import logging
import traceback
import functools

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Set Tesseract OCR path (adjust path as needed for your system)
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

app = Flask(__name__)

# Enable CORS for all routes
CORS(app, origins=['http://localhost:3000', 'http://127.0.0.1:3000'], 
     methods=['GET', 'POST', 'OPTIONS'],
     allow_headers=['Content-Type', 'Authorization'])

# Initialize models
logger.info("Loading models...")
try:
    # Load sentence transformer for embeddings
    embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    logger.info("Embedding model loaded successfully")
    
    # Load BLIP model for image captioning
    blip_processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
    blip_model = BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-base")
    logger.info("BLIP model loaded successfully")
    
    # Check if CUDA is available
    device = "cuda" if torch.cuda.is_available() else "cpu"
    blip_model = blip_model.to(device)
    logger.info(f"Using device: {device}")
    
except Exception as e:
    logger.error(f"Error loading models: {str(e)}")
    raise e

def decode_base64_image(image_data):
    """Decode base64 image data to PIL Image"""
    try:
        # Handle data URL format if present
        if ',' in image_data and image_data.startswith('data:'):
            image_data = image_data.split(',')[1]
        
        image_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(image_bytes))
        
        # Convert to RGB if needed
        if image.mode != 'RGB':
            image = image.convert('RGB')
            
        logger.info(f"Image decoded successfully: {image.size}, mode: {image.mode}")
        return image
    except Exception as e:
        logger.error(f"Error decoding image: {str(e)}")
        logger.error(f"Image data preview: {image_data[:100]}...")
        raise e

def safe_image_processing(func):
    """Decorator to safely handle image processing errors"""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            logger.error(f"Image processing error: {str(e)}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            return jsonify({
                'error': f'Image processing failed: {str(e)}',
                'details': 'Check server logs for more information'
            }), 500
    return wrapper

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    try:
        return jsonify({
            'status': 'healthy',
            'models_loaded': True,
            'device': device,
            'tesseract_available': True,
            'blip_model_loaded': True,
            'embedding_model_loaded': True
        })
    except Exception as e:
        return jsonify({
            'status': 'unhealthy',
            'error': str(e)
        }), 500

@app.route('/embed', methods=['POST'])
def embed_text():
    """Generate embeddings for text"""
    try:
        data = request.get_json()
        if not data or 'text' not in data:
            return jsonify({'error': 'Text field is required'}), 400
            
        text = data.get('text', '').strip()
        if not text:
            return jsonify({'error': 'Text cannot be empty'}), 400
            
        logger.info(f"Generating embedding for text: {text[:100]}...")
        
        # Generate embedding
        embedding = embedding_model.encode(text).tolist()
        
        logger.info(f"Embedding generated successfully, dimension: {len(embedding)}")
        
        return jsonify({
            'embedding': embedding,
            'dimension': len(embedding)
        })
        
    except Exception as e:
        logger.error(f"Error generating embedding: {str(e)}")
        return jsonify({'error': f'Failed to generate embedding: {str(e)}'}), 500

@app.route('/ocr', methods=['POST', 'OPTIONS'])
@safe_image_processing
def extract_text_from_image():
    """Extract text from image using OCR"""
    if request.method == 'OPTIONS':
        return '', 200
        
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'Image field is required'}), 400
            
        image_data = data.get('image', '')
        if not image_data:
            return jsonify({'error': 'Image data cannot be empty'}), 400
            
        logger.info("Starting OCR processing...")
        
        # Decode image
        image = decode_base64_image(image_data)
        
        # Perform OCR with multiple configurations for better results
        ocr_configs = [
            '--psm 6',  # Uniform block of text
            '--psm 4',  # Single column of text
            '--psm 3',  # Fully automatic page segmentation
            '--psm 1',  # Automatic page segmentation with OSD
        ]
        
        best_text = ""
        for config in ocr_configs:
            try:
                text = pytesseract.image_to_string(image, config=config).strip()
                if len(text) > len(best_text):
                    best_text = text
            except Exception as config_error:
                logger.warning(f"OCR config {config} failed: {config_error}")
                continue
        
        # Clean up the text
        if best_text:
            # Remove excessive whitespace and clean up
            lines = [line.strip() for line in best_text.split('\n') if line.strip()]
            best_text = '\n'.join(lines)
        
        logger.info(f"OCR completed. Text length: {len(best_text)}")
        logger.info(f"OCR result preview: {best_text[:200]}...")
        
        return jsonify({
            'text': best_text if best_text else 'No text found in image',
            'has_text': len(best_text) > 0,
            'method': 'tesseract_ocr',
            'confidence': 'high' if len(best_text) > 50 else 'medium' if len(best_text) > 10 else 'low'
        })
        
    except Exception as e:
        logger.error(f"Error extracting text from image: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'OCR failed: {str(e)}'}), 500

@app.route('/generate-caption', methods=['POST', 'OPTIONS'])
@safe_image_processing
def generate_image_caption():
    """Generate caption for image using BLIP"""
    if request.method == 'OPTIONS':
        return '', 200
        
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'Image field is required'}), 400
            
        image_data = data.get('image', '')
        if not image_data:
            return jsonify({'error': 'Image data cannot be empty'}), 400
            
        logger.info("Starting BLIP caption generation...")
        
        # Decode image
        image = decode_base64_image(image_data)
        
        # Process with BLIP
        inputs = blip_processor(images=image, return_tensors="pt").to(device)
        
        with torch.no_grad():
            outputs = blip_model.generate(
                **inputs,
                max_length=75,  # Increased for more detailed descriptions
                num_beams=5,
                early_stopping=True,
                do_sample=False,
                temperature=0.7
            )
        
        caption = blip_processor.decode(outputs[0], skip_special_tokens=True)
        
        # Enhanced caption cleaning
        original_caption = caption
        caption = caption.strip()
        
        # Remove common prefixes
        prefixes_to_remove = [
            'a picture of', 'an image of', 'a photo of', 'the image shows',
            'this image shows', 'the picture shows', 'this picture shows'
        ]
        
        for prefix in prefixes_to_remove:
            if caption.lower().startswith(prefix):
                caption = caption[len(prefix):].strip()
                break
        
        # Capitalize first letter if needed
        if caption and caption[0].islower():
            caption = caption[0].upper() + caption[1:]
        
        # Add period if missing
        if caption and not caption.endswith('.'):
            caption += '.'
        
        logger.info(f"Caption generated: {caption}")
        
        return jsonify({
            'caption': caption,
            'original_caption': original_caption,
            'method': 'blip_captioning',
            'device_used': device,
            'image_size': f"{image.size[0]}x{image.size[1]}"
        })
        
    except Exception as e:
        logger.error(f"Error generating caption: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Caption generation failed: {str(e)}'}), 500

@app.route('/process-image', methods=['POST', 'OPTIONS'])
@safe_image_processing
def process_image():
    """
    Smart image processing: Try OCR first, fall back to BLIP if no meaningful text found
    This endpoint combines both approaches intelligently
    """
    if request.method == 'OPTIONS':
        return '', 200
        
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'Image field is required'}), 400
            
        image_data = data.get('image', '')
        if not image_data:
            return jsonify({'error': 'Image data cannot be empty'}), 400
            
        logger.info("Starting smart image processing...")
        
        # Decode image
        image = decode_base64_image(image_data)
        
        # Try OCR first
        try:
            ocr_text = pytesseract.image_to_string(image, config='--psm 6').strip()
            
            # Clean OCR text
            if ocr_text:
                lines = [line.strip() for line in ocr_text.split('\n') if line.strip()]
                ocr_text = '\n'.join(lines)
            
            logger.info(f"OCR result length: {len(ocr_text)}")
            
        except Exception as ocr_error:
            logger.warning(f"OCR failed: {ocr_error}")
            ocr_text = ""
        
        # If substantial text is found, use OCR
        word_count = len(ocr_text.split()) if ocr_text else 0
        if word_count >= 5 and len(ocr_text) > 15:
            logger.info("Using OCR result (sufficient text found)")
            return jsonify({
                'text': ocr_text,
                'method': 'ocr',
                'type': 'text_extraction',
                'confidence': 'high' if word_count > 20 else 'medium',
                'word_count': word_count
            })
        
        # Otherwise, use BLIP for description
        logger.info("Switching to BLIP caption generation (insufficient text found)")
        
        inputs = blip_processor(images=image, return_tensors="pt").to(device)
        
        with torch.no_grad():
            outputs = blip_model.generate(
                **inputs,
                max_length=75,
                num_beams=5,
                early_stopping=True,
                do_sample=False,
                temperature=0.7
            )
        
        caption = blip_processor.decode(outputs[0], skip_special_tokens=True)
        
        # Clean up caption
        original_caption = caption
        caption = caption.strip()
        
        prefixes_to_remove = [
            'a picture of', 'an image of', 'a photo of', 'the image shows',
            'this image shows', 'the picture shows', 'this picture shows'
        ]
        
        for prefix in prefixes_to_remove:
            if caption.lower().startswith(prefix):
                caption = caption[len(prefix):].strip()
                break
        
        if caption and caption[0].islower():
            caption = caption[0].upper() + caption[1:]
        
        if caption and not caption.endswith('.'):
            caption += '.'
            
        logger.info("BLIP caption generation completed")
        
        return jsonify({
            'text': caption,
            'method': 'blip',
            'type': 'image_description',
            'ocr_text': ocr_text if ocr_text else None,
            'confidence': 'high',
            'original_caption': original_caption,
            'word_count': len(caption.split()) if caption else 0
        })
        
    except Exception as e:
        logger.error(f"Error processing image: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Image processing failed: {str(e)}'}), 500

@app.route('/test-connection', methods=['GET'])
def test_connection():
    """Test endpoint to verify API connectivity"""
    return jsonify({
        'status': 'connected',
        'message': 'Embeddings API is working properly',
        'timestamp': str(torch.tensor([1.0]).item()),
        'device': device
    })

@app.errorhandler(413)
def too_large(e):
    return jsonify({'error': 'File too large - maximum size is 10MB'}), 413

@app.errorhandler(400)
def bad_request(e):
    return jsonify({'error': 'Bad request - please check your request format'}), 400

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(500)
def internal_error(e):
    logger.error(f"Internal server error: {str(e)}")
    return jsonify({'error': 'Internal server error - check server logs'}), 500

@app.before_request
def log_request():
    """Log incoming requests for debugging"""
    if request.method != 'OPTIONS':
        logger.info(f"Incoming {request.method} request to {request.path}")
        if request.is_json:
            data = request.get_json()
            if data and 'image' in data:
                logger.info(f"Request contains image data: {len(data['image'])} characters")
            else:
                logger.info(f"Request data: {str(data)[:200]}...")

@app.after_request
def after_request(response):
    """Add CORS headers to all responses"""
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response

if __name__ == '__main__':
    logger.info("Starting Flask server...")
    logger.info(f"Available endpoints:")
    logger.info("  GET  /health - Health check")
    logger.info("  GET  /test-connection - Test connectivity")
    logger.info("  POST /embed - Generate text embeddings")
    logger.info("  POST /ocr - Extract text from images")
    logger.info("  POST /generate-caption - Generate image captions")
    logger.info("  POST /process-image - Smart image processing (OCR + BLIP)")
    logger.info(f"Server will run on device: {device}")
    logger.info("CORS enabled for frontend communication")
    
    app.run(
        host='127.0.0.1', 
        port=8000, 
        debug=True,  # Enable debug for better error tracking
        threaded=True,
        use_reloader=False  # Avoid model reloading issues
    )