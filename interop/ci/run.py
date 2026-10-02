"""One exact-source Linux bridge build and fourteen existing protocol tests."""
from pathlib import Path
import ctypes
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
RUST=ROOT.parent/'fips'
INPUTS=json.loads((ROOT/'interop/ci/inputs.json').read_text())
OUT=Path(os.environ['RUNNER_TEMP'])/'fips-interop-proof'
TARGET=Path(os.environ['RUNNER_TEMP'])/'fips-interop-target'
GIB=2**30
START=time.monotonic()
WORK_DEADLINE=START+1050
STATE={'status':'failed','startedAt':time.time(),'commands':[],'inputsSha256':hashlib.sha256((ROOT/'interop/ci/inputs.json').read_bytes()).hexdigest(),'workflowRun':os.environ.get('GITHUB_RUN_ID'),'workflowAttempt':os.environ.get('GITHUB_RUN_ATTEMPT')}
OUT.mkdir(exist_ok=False)
ENV={**os.environ,'CARGO_TARGET_DIR':str(TARGET),'CARGO_BUILD_JOBS':'1','CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_TERM_COLOR':'never','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD':'1','PUPPETEER_SKIP_DOWNLOAD':'1'}
# Reparent only this runner's orphaned children here, so cleanup cannot lose them.
assert sys.platform=='linux' and ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save():
    temporary=OUT/'proof.tmp';temporary.write_text(json.dumps(STATE,indent=2)+'\n');temporary.replace(OUT/'proof.json')
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args],text=True,timeout=15).strip()
def source_guard():
    assert git(ROOT,'rev-parse','HEAD')==os.environ['GITHUB_SHA']
    assert git(RUST,'rev-parse','HEAD')==INPUTS['rustSource']
    assert git(RUST,'rev-parse','HEAD^{tree}')==INPUTS['rustTree']
    assert not git(ROOT,'status','--porcelain') and not git(RUST,'status','--porcelain')
    allowed={'.github/workflows/rust-interop.yml','interop/ci/run.py','interop/ci/inputs.json','interop/ci/Cargo.lock'}
    changed=set(git(ROOT,'diff','--name-only',INPUTS['typescriptBase'],'HEAD').splitlines())
    assert changed<=allowed,changed
    assert not git(ROOT,'diff',INPUTS['publishedCoreReference'],INPUTS['typescriptBase'],'--','packages/core','interop/rust-bridge','pnpm-lock.yaml')
    for name,digest in INPUTS['typescriptFiles'].items():assert sha(ROOT/name)==digest,name
    assert sha(RUST/'Cargo.lock')==INPUTS['rustSourceLockSha256']
    assert sha(ROOT/'interop/ci/Cargo.lock')==INPUTS['bridgeLockSha256']
    for key in ['RUSTFLAGS','RUSTDOCFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_ENCODED_RUSTDOCFLAGS','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER']:
        assert not os.environ.get(key),key
    assert not any(k.startswith('CARGO_TARGET_') and k.endswith(('RUSTFLAGS','RUSTDOCFLAGS')) and v for k,v in os.environ.items())
    for root in [ROOT,RUST,ROOT.parent,ROOT/'interop',ROOT/'interop/rust-bridge']:
        assert not (root/'.cargo/config').exists() and not (root/'.cargo/config.toml').exists()
    cargo_home=Path(os.environ.get('CARGO_HOME',str(Path.home()/'.cargo')))
    assert not (cargo_home/'config').exists() and not (cargo_home/'config.toml').exists()

def processes():
    result={}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            line=(p/'stat').read_text();fields=line[line.rfind(')')+2:].split()
            result[int(p.name)]={'pid':int(p.name),'state':fields[0],'ppid':int(fields[1]),'pgid':int(fields[2]),'start':fields[19]}
        except (FileNotFoundError,ProcessLookupError,PermissionError):continue
    return result

def command(name,args,cwd,limit):
    source_guard();assert shutil.disk_usage(OUT).free>=8*GIB,'8 GiB launch reserve'
    row={'name':name,'command':args,'startedAt':time.time(),'limitSeconds':limit,'owned':[]};STATE['commands'].append(row);save()
    owned={};child=None;started=time.monotonic();error=None
    def sample():
        rows=processes();parents={os.getpid()}|{pid for pid,r in owned.items() if rows.get(pid,{}).get('start')==r['start']}
        while True:
            fresh={pid:r for pid,r in rows.items() if pid not in owned and r['ppid'] in parents}
            if not fresh:break
            owned.update(fresh);parents.update(fresh)
        return [r for pid,r in owned.items() if rows.get(pid,{}).get('start')==r['start'] and rows[pid]['state']!='Z']
    try:
        with (OUT/(name+'.log')).open('x') as log:
            child=subprocess.Popen(args,cwd=cwd,env=ENV,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
            while True:
                sample();free=shutil.disk_usage(OUT).free;row['minFreeBytes']=min(row.get('minFreeBytes',free),free)
                assert free>=5*GIB,'5 GiB runtime reserve'
                assert time.monotonic()<WORK_DEADLINE and time.monotonic()-started<limit,'Command time bound'
                if child.poll() is not None:row['exitCode']=child.returncode;break
                time.sleep(.1)
    except BaseException as e:error=e
    finally:
        row['remainingAtLeaderExit']=sample();cleanup=time.monotonic();row['signals']=[]
        for sig in [signal.SIGTERM,signal.SIGKILL]:
            for r in reversed(sample()):
                current=processes().get(r['pid'])
                if current and current['start']==r['start']:
                    try:os.kill(r['pid'],sig);row['signals'].append({'pid':r['pid'],'signal':int(sig)})
                    except ProcessLookupError:pass
            until=time.monotonic()+5
            while sample() and time.monotonic()<until:time.sleep(.05)
        if child:child.wait(timeout=5)
        while True:
            try:
                if os.waitpid(-1,os.WNOHANG)[0]==0:break
            except ChildProcessError:break
        row['owned']=list(owned.values());row['survivors']=sample();row['allChildrenClosed']=not row['survivors']
        row['cleanupSeconds']=time.monotonic()-cleanup;row['elapsedSeconds']=time.monotonic()-started
        if (OUT/(name+'.log')).exists():row['logSha256']=sha(OUT/(name+'.log'))
        if error:row['error']=repr(error)
        save()
    assert not error,repr(error)
    assert row.get('exitCode')==0 and row['allChildrenClosed'] and row['cleanupSeconds']<30,name
    assert not row['remainingAtLeaderExit'],'Successful command left running descendants'
    source_guard();return OUT/(name+'.log')

def interrupted(sig,frame):raise RuntimeError('Interrupted '+str(sig))
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,interrupted)
try:
    source_guard()
    STATE.update(typescriptSource=git(ROOT,'rev-parse','HEAD'),typescriptTree=git(ROOT,'rev-parse','HEAD^{tree}'),rustSource=INPUTS['rustSource'],rustTree=INPUTS['rustTree'],workflowSha256=sha(ROOT/'.github/workflows/rust-interop.yml'),runnerSha256=sha(Path(__file__)))
    assert json.loads((ROOT/'packages/core/package.json').read_text())['version']=='0.0.48'
    versions={}
    for name,args in [('rustc',['rustc','+1.96.0','--version']),('cargo',['cargo','+1.96.0','--version']),('pnpm',['pnpm','--version']),('node',['node','--version'])]:versions[name]=command(name,args,ROOT,15).read_text().strip()
    assert versions['rustc'].startswith('rustc 1.96.0 ') and versions['cargo'].startswith('cargo 1.96.0 ') and versions['pnpm']=='9.15.4';STATE['versions']=versions
    command('install',['pnpm','install','--frozen-lockfile'],ROOT,180)
    bridge=ROOT/'interop/rust-bridge';shutil.copyfile(ROOT/'interop/ci/Cargo.lock',bridge/'Cargo.lock')
    assert sha(bridge/'Cargo.lock')==INPUTS['bridgeLockSha256']
    assert git(ROOT,'check-ignore','interop/rust-bridge/Cargo.lock')=='interop/rust-bridge/Cargo.lock'
    assert not git(ROOT,'ls-files','interop/rust-bridge/Cargo.lock')
    STATE['bridgeLockIgnoredAndUntracked']=True
    log=command('bridge-build',['cargo','+1.96.0','build','--locked','--message-format=json-render-diagnostics','--manifest-path',str(bridge/'Cargo.toml')],ROOT,780)
    artifacts=[]
    for line in log.read_text().splitlines():
        try:r=json.loads(line)
        except json.JSONDecodeError:continue
        if r.get('reason')=='compiler-artifact' and r.get('executable') and r['target']['name']=='fips-rust-bridge':artifacts.append(r)
    assert len(artifacts)==1 and Path(artifacts[0]['target']['src_path']).resolve()==bridge/'src/main.rs'
    binary=Path(artifacts[0]['executable']).resolve();assert binary.is_relative_to(TARGET) and binary.is_file() and os.access(binary,os.X_OK)
    STATE['bridge']={'artifact':artifacts[0],'sha256':sha(binary),'bytes':binary.stat().st_size,'lockSha256':sha(bridge/'Cargo.lock')};ENV['FIPS_RUST_BRIDGE_BIN']=str(binary)
    metadata=json.loads(command('cargo-metadata',['cargo','+1.96.0','metadata','--locked','--offline','--format-version=1','--manifest-path',str(bridge/'Cargo.toml')],ROOT,30).read_text())
    for name,version,manifest in [('nvpn-fips-core','0.4.90','crates/fips-core/Cargo.toml'),('nvpn-fips-identity','0.3.3','crates/fips-identity/Cargo.toml')]:
        packages=[p for p in metadata['packages'] if p['name']==name];assert len(packages)==1
        p=packages[0];assert p['version']==version and p['source'] is None and Path(p['manifest_path']).resolve()==RUST/manifest
    command('interop',['pnpm','exec','vitest','run','test/interop','--maxWorkers=1','--retry=0','--reporter=default','--reporter=json','--outputFile='+str(OUT/'vitest.json')],ROOT/'packages/core',90)
    report=json.loads((OUT/'vitest.json').read_text());assert report['success'] and report['numTotalTests']==report['numPassedTests']==14
    assert report['numFailedTests']==report['numPendingTests']==report['numTodoTests']==0 and len(report['testResults'])==8
    actual={}
    for result in report['testResults']:
        assert result['status']=='passed';name=Path(result['name']).name;assert name not in actual
        assertions=result['assertionResults'];assert all(a['status']=='passed' and not a.get('failureMessages') for a in assertions)
        actual[name]=[a['title'] for a in assertions]
    assert {k:sorted(v) for k,v in actual.items()}=={k:sorted(v) for k,v in INPUTS['tests'].items()}
    assert sha(binary)==STATE['bridge']['sha256'] and sha(bridge/'Cargo.lock')==INPUTS['bridgeLockSha256']
    STATE.update(status='passed',actualTests=14,actualFiles=8,skipped=0,retries=0,testNames=actual,vitestSha256=sha(OUT/'vitest.json'))
except BaseException as error:STATE['error']=repr(error)
finally:
    try:source_guard();STATE['sourcesUnchanged']=True
    except BaseException as error:STATE['sourcesUnchanged']=False;STATE['sourceError']=repr(error);STATE['status']='failed'
    remaining=[r for r in processes().values() if r['ppid']==os.getpid() and r['state']!='Z']
    groups=sorted({p['pgid'] for c in STATE['commands'] for p in c.get('owned',[])})
    live_groups=[r for r in processes().values() if r['pgid'] in groups and r['state']!='Z']
    STATE['allOwnedChildrenClosed']=not remaining and not live_groups and all(r.get('allChildrenClosed') for r in STATE['commands']);STATE['survivors']=remaining
    STATE['ownedGroups']=groups;STATE['allOwnedGroupsClosed']=not live_groups
    STATE['elapsedSeconds']=time.monotonic()-START;STATE['finishedAt']=time.time()
    if not STATE['allOwnedChildrenClosed'] or STATE['elapsedSeconds']>1080:STATE['status']='failed'
    save()
print(json.dumps({k:STATE.get(k) for k in ['status','actualTests','actualFiles','skipped','retries','allOwnedChildrenClosed','error']}))
sys.exit(0 if STATE['status']=='passed' else 1)
