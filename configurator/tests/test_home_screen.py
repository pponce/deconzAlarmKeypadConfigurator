"""Home-screen metadata and public icon routes use only local static assets."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import struct
import threading
import unittest
from configurator.server import handler, Security, ASSETS
from configurator.package import FILES

class HomeScreenTests(unittest.TestCase):
    def test_public_assets_manifest_and_entry_pages(self):
        assets=Path(__file__).parents[1]/'static'
        config={'origin':'https://fixture.invalid'}
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(config,Security(config),assets))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            for name,mime in [('apple-touch-icon.png','image/png'),('app-icon-192.png','image/png'),('app-icon-512.png','image/png'),('app-icon.svg','image/svg+xml'),('manifest.webmanifest','application/manifest+json')]:
                conn=HTTPConnection('127.0.0.1',server.server_port)
                conn.request('GET','/'+name,headers={'Host':'fixture.invalid'})
                reply=conn.getresponse();raw=reply.read()
                self.assertEqual(reply.status,200);self.assertTrue(reply.getheader('Content-Type').startswith(mime))
                self.assertIn("manifest-src 'self'",reply.getheader('Content-Security-Policy'))
                
                if name!='manifest.webmanifest':self.assertEqual(raw,(assets/name).read_bytes())
                else:self.assertEqual(json.loads(raw)['short_name'],'Keypad Cntrl')
                self.assertIn('static/'+name,FILES)
                if name.endswith('.png'):
                    self.assertEqual(raw[:8],b'\x89PNG\r\n\x1a\n')
                    size=180 if name.startswith('apple') else int(name.split('-')[-1][:-4])
                    self.assertEqual(struct.unpack('>II',raw[16:24]),(size,size))
                conn.close()
            manifest=json.loads((assets/'manifest.webmanifest').read_text())
            self.assertEqual(manifest['start_url'],'/');self.assertEqual(manifest['display'],'standalone')
            for icon in manifest['icons']:self.assertIn(icon['src'],ASSETS)
            for name in ('index.html','welcome.html','setup.html'):
                html=(assets/name).read_text()
                self.assertIn('rel="apple-touch-icon"',html);self.assertIn('href="/manifest.webmanifest"',html)
        finally:server.shutdown();server.server_close();worker.join()

    def test_custom_name_is_public_escaped_and_contains_no_private_configuration(self):
        from unittest.mock import patch
        from configurator import server as module
        assets=Path(__file__).parents[1]/'static'
        cfg={'origin':'https://fixture.invalid','socket':'synthetic'}
        name='Test " & <Admin>'
        http=ThreadingHTTPServer(('127.0.0.1',0),handler(cfg,Security(cfg),assets))
        worker=threading.Thread(target=http.serve_forever,daemon=True);worker.start()
        try:
            with patch.object(module,'rpc',return_value={'home_screen_name':name,'private':'must-not-leak'}) as rpc:
                for route in ('/','/welcome.html','/setup.html','/manifest.webmanifest'):
                    conn=HTTPConnection('127.0.0.1',http.server_port)
                    conn.request('GET',route,headers={'Host':'fixture.invalid'})
                    response=conn.getresponse();raw=response.read().decode();conn.close()
                    self.assertEqual(response.status,200);self.assertNotIn('must-not-leak',raw)
                    if route.endswith('webmanifest'):
                        self.assertEqual(json.loads(raw)['name'],name);self.assertEqual(json.loads(raw)['short_name'],name)
                    else:self.assertIn('Test &quot; &amp; &lt;Admin&gt;',raw)
                for call in rpc.call_args_list:self.assertEqual(call.args,('synthetic','public_branding',{}))
        finally:http.shutdown();http.server_close();worker.join()
