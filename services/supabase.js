'use strict';

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requises');
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws },
});

const supabase = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
  realtime: { transport: ws },
});

module.exports = { supabase, supabaseAdmin };