import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import formBodyPlugin from '@fastify/formbody';
import WebSocket from 'ws';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const fastify = Fastify({
  logger: {
    level: 'debug',
    transport: {
      target: 'pino-pretty'
    }
  },
  trustProxy: true
});

// Register plugins
await fastify.register(websocketPlugin, {
  options: {
    maxPayload: 1048576, // 1MB
    clientTracking: true,
    verifyClient: (info, cb) => {
      fastify.log.info('WebSocket verification attempt', {
        origin: info.origin,
        secure: info.secure,
        req: {
          url: info.req.url,
          headers: info.req.headers,
          method: info.req.method,
          rawHeaders: info.req.rawHeaders
        }
      });
      cb(true);
    }
  }
});
await fastify.register(formBodyPlugin);

// Add raw request logging
fastify.addHook('onRequest', (request, reply, done) => {
  fastify.log.info('Incoming request', {
    method: request.method,
    url: request.url,
    headers: request.headers,
    protocol: request.protocol,
    hostname: request.hostname
  });
  done();
});

// Get signed URL from ElevenLabs
async function getSignedUrl(agentId, apiKey) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
    {
      headers: {
        'xi-api-key': apiKey
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.signed_url;
}

// Health check endpoint
fastify.get('/', async (request, reply) => {
  return { status: 'ok' };
});

// Test WebSocket endpoint
fastify.get('/test-ws', { websocket: true }, (connection, req) => {
  fastify.log.info('Test WebSocket connection attempt', {
    headers: req.headers,
    url: req.url,
    protocol: req.protocol
  });
  
  connection.socket.on('open', () => {
    fastify.log.info('Test WebSocket connection opened');
  });
  
  connection.socket.on('error', (error) => {
    fastify.log.error('Test WebSocket error:', error);
  });
  
  connection.socket.on('message', (message) => {
    fastify.log.info('Test message received:', message.toString());
    connection.socket.send('Server received: ' + message);
  });
});

// WebSocket endpoint
fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
  fastify.log.info('New Twilio connection attempt', { 
    headers: req.headers,
    query: req.query
  });
  
  try {
    const signedUrl = await getSignedUrl(
      process.env.ELEVENLABS_AGENT_ID,
      process.env.ELEVENLABS_API_KEY
    );
    
    fastify.log.info('Got signed URL from ElevenLabs');
    
    // Connect to ElevenLabs
    const elevenlabs = new WebSocket(signedUrl);
    
    elevenlabs.on('open', () => {
      fastify.log.info('Connected to ElevenLabs WebSocket');
    });

    elevenlabs.on('error', (error) => {
      fastify.log.error('ElevenLabs WebSocket error:', error);
    });
    
    // Handle messages from ElevenLabs to Twilio
    elevenlabs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        fastify.log.info('Received message from ElevenLabs:', message.type);
        
        if (message.type === 'audio' && message.audio_event?.audio_base_64) {
          connection.socket.send(JSON.stringify({
            event: 'media',
            media: {
              payload: message.audio_event.audio_base_64
            }
          }));
        } else if (message.type === 'error') {
          fastify.log.error('ElevenLabs error:', message);
        }
      } catch (error) {
        fastify.log.error('Error processing ElevenLabs message:', error);
      }
    });
    
    // Handle messages from Twilio to ElevenLabs
    connection.socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.event === 'media' && message.media?.payload) {
          elevenlabs.send(JSON.stringify({
            user_audio_chunk: message.media.payload
          }));
        }
      } catch (error) {
        fastify.log.error('Error processing Twilio message:', error);
      }
    });
    
    // Handle WebSocket closure
    connection.socket.on('close', () => {
      fastify.log.info('Twilio connection closed');
      elevenlabs.close();
    });
    
    elevenlabs.on('close', () => {
      fastify.log.info('ElevenLabs connection closed');
      connection.socket.close();
    });
    
  } catch (error) {
    fastify.log.error('Error in WebSocket handler:', error);
    connection.socket.close();
  }
});

// Start the server
try {
  const port = process.env.PORT || 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`Server listening on port ${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
} 