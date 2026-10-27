"""Loads the plugin through a stub of Hermes' ctx and calls the model-free tools against a local page.
Run from the directory ABOVE the plugin:  python3 -m jevim.smoke_plugin   (folder must be named `jevim`)."""
import http.server, json, threading, sys, importlib

PAGE = b"<html><body><h1>Shop</h1><a href='/jobs'>Jobs</a><button>Sign in</button><input aria-label='Email'></body></html>"
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.send_header('content-type','text/html'); self.end_headers(); self.wfile.write(PAGE)
    def log_message(self,*a): pass

class Ctx:
    def __init__(self): self.tools={}; self.skills={}
    def register_tool(self,name,toolset,schema,handler,**kw): self.tools[name]=(schema,handler,kw)
    def register_skill(self,name,path): self.skills[name]=path

def main():
    pkg = importlib.import_module(__package__ or 'jevim')
    ctx = Ctx(); pkg.register(ctx)
    declared = {l.split('- ')[1].strip() for l in open(pkg.__path__[0]+'/plugin.yaml') if l.startswith('  - ')}
    assert declared == set(ctx.tools), (declared ^ set(ctx.tools))
    for n,(s,h,k) in ctx.tools.items():
        assert s['name']==n and s['parameters']['type']=='object'
    assert 'jevim-browser' in ctx.skills
    import os, tempfile
    os.environ['HERMES_HOME'] = tempfile.mkdtemp()
    g = json.loads(ctx.tools['jevim_index'][1]({'url':'https://example.com'}))
    assert g['error']=='canon_unconfirmed', g
    c = json.loads(ctx.tools['jevim_canon'][1]({}))
    bad = json.loads(ctx.tools['jevim_canon_confirm'][1]({'agent':'t','sha256':'0'*64,'restated':'x'}))
    assert 'error' in bad
    shallow = json.loads(ctx.tools['jevim_canon_confirm'][1]({'agent':'t','sha256':c['canon_sha256'],'restated':'ok i read it'}))
    assert 'error' in shallow
    words = ('Every payment rail is owned by a company that can switch an agent off, so control is the problem. A balance in a platform database '
             'is only a receivable, not revenue. Nobody refused over fees, so cheap is not the pitch. A rail gets adopted when it is needed, '
             'not when it is explained. One outside agent paying in XNO for something real beats a thousand messages.')
    ok = json.loads(ctx.tools['jevim_canon_confirm'][1]({'agent':'smoke','sha256':c['canon_sha256'],'restated':words}))
    assert ok['confirmed'] and ok['canon_sha256']==c['canon_sha256'] and len(ok['receipt'])==64, ok
    print('canon gate OK, receipt', ok['receipt'][:16])
    # a refusal path (private address) must come back as JSON, not raise
    r = json.loads(ctx.tools['jevim_index'][1]({'url':'http://127.0.0.1:1/'}))
    print('private-address refusal:', str(r)[:120])
    srv = http.server.HTTPServer(('127.0.0.1',0),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
    print('missing arg:', ctx.tools['jevim_ground'][1]({}))
    print('browse w/o key:', ctx.tools['jevim_browse'][1]({'task':'open the jobs page','website':'https://example.com'})[:120])
    print('OK registered', len(ctx.tools), 'tools')
main()
