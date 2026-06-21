'use strict';
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis');
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket },
  }
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: WebSocket } }
);

module.exports = { supabase, supabaseAdmin };