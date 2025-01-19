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
fastify.get('/media-stream', { 
  websocket: true,
  handler: async (connection, req) => {
    fastify.log.info('New Twilio connection attempt', { 
      headers: req.headers,
      query: req.query,
      url: req.url,
      method: req.method,
      protocol: req.protocol,
      hostname: req.hostname,
      ip: req.ip
    });
    
    let streamSid = null;
    let isConnectedToElevenLabs = false;
    
    connection.socket.on('error', (error) => {
      fastify.log.error('Twilio WebSocket error:', error);
    });

    connection.socket.on('open', () => {
      fastify.log.info('Twilio WebSocket connection opened');
    });
    
    try {
      // Send initial protocol message
      connection.socket.send(JSON.stringify({
        event: 'connected'
      }));
      fastify.log.info('Sent connected event to Twilio');

      const signedUrl = await getSignedUrl(
        process.env.ELEVENLABS_AGENT_ID,
        process.env.ELEVENLABS_API_KEY
      );
      
      fastify.log.info('Got signed URL from ElevenLabs:', signedUrl);
      
      // Connect to ElevenLabs
      const elevenlabs = new WebSocket(signedUrl);
      
      elevenlabs.on('open', () => {
        fastify.log.info('Connected to ElevenLabs WebSocket');
        isConnectedToElevenLabs = true;
        // Send start message to Twilio
        connection.socket.send(JSON.stringify({
          event: 'start',
          protocol: 'websocket-media',
          version: '1.0.0'
        }));
        fastify.log.info('Sent start event to Twilio');
      });

      elevenlabs.on('error', (error) => {
        fastify.log.error('ElevenLabs WebSocket error:', error);
        isConnectedToElevenLabs = false;
      });
      
      // Handle messages from Twilio to ElevenLabs
      connection.socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          fastify.log.info('Received message from Twilio:', message);

          if (message.event === 'start') {
            streamSid = message.streamSid;
            fastify.log.info('Stream started with SID:', streamSid);
          }
          else if (message.event === 'media' && message.media?.payload && isConnectedToElevenLabs) {
            fastify.log.info('Forwarding audio to ElevenLabs');
            elevenlabs.send(JSON.stringify({
              text: "",  // Required for conversation
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5
              },
              user_audio_chunk: message.media.payload,  // Use user_audio_chunk instead of audio
              optimize_streaming_latency: 4
            }));
          }
          else if (message.event === 'stop') {
            fastify.log.info('Stream stopped:', message);
            elevenlabs.close();
          }
        } catch (error) {
          fastify.log.error('Error processing Twilio message:', error);
        }
      });
      
      // Handle messages from ElevenLabs to Twilio
      elevenlabs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          fastify.log.info('Received message from ElevenLabs:', {
            type: message.type,
            hasAudio: !!message.audio,
            hasAudioEvent: !!message.audio_event
          });
          
          if (message.type === 'audio' && message.audio) {
            fastify.log.info('Sending audio back to Twilio');
            connection.socket.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: message.audio
              }
            }));
          } else if (message.type === 'error') {
            fastify.log.error('ElevenLabs error:', message);
          }
        } catch (error) {
          fastify.log.error('Error processing ElevenLabs message:', error);
        }
      });
      
      // Handle WebSocket closure
      connection.socket.on('close', () => {
        fastify.log.info('Twilio connection closed');
        if (isConnectedToElevenLabs) {
          elevenlabs.close();
        }
      });
      
      elevenlabs.on('close', () => {
        fastify.log.info('ElevenLabs connection closed');
        isConnectedToElevenLabs = false;
        connection.socket.close();
      });
      
    } catch (error) {
      fastify.log.error('Error in WebSocket handler:', error);
      connection.socket.close();
    }
  }
});

// Start the server
try {
  const port = process.env.PORT || 3000;
  await fastify.listen({ 
    port, 
    host: '0.0.0.0',
    backlog: 511
  });
  console.log(`Server listening on port ${port}`);
  fastify.log.info('Server configuration:', {
    port,
    address: '0.0.0.0',
    websocketPath: '/media-stream'
  });
} catch (err) {
  fastify.log.error('Error starting server:', err);
  process.exit(1);
} 