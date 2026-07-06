// /assessment/js/discovery.js
// "Help me choose" discovery intake for the Blueprint funnel (tiers.html).
// Three questions, rule-based tier recommendation, all tiers stay selectable.
// Tier facts come from /lib/blueprint-tiers.json (via window.SR_TIERS_PROMISE
// set by tiers.html, with a direct fetch as fallback). Checkout goes through
// window.srStartCheckout, the same path the tier cards use.
(function(){
  var QUESTIONS=[
    {
      key:'area',
      title:'What area of your life is this for?',
      options:[
        {key:'relationships',label:'Relationships (dating, marriage, partnerships)'},
        {key:'family',label:'Family (parenting, family of origin, household)'},
        {key:'career',label:'Career (leadership, work, teams)'},
        {key:'ministry',label:'Ministry (faith work, calling, service)'},
        {key:'justme',label:'Just me (personal growth)'}
      ]
    },
    {
      key:'pattern',
      title:'What pattern keeps hitting you?',
      options:[
        {key:'samefight',label:'Same fight or conflict keeps coming back'},
        {key:'startstop',label:'I keep starting things and not finishing'},
        {key:'misread',label:'People misread me or I misread them'},
        {key:'cannotname',label:'I know something is off but I cannot name it'},
        {key:'wired',label:'I want to understand how I am wired'}
      ]
    },
    {
      key:'time',
      title:'How much time do you have to invest today?',
      options:[
        {key:'under15',label:'Under 15 minutes (I want a quick snapshot)'},
        {key:'mid',label:'15 to 25 minutes (I want the core toolkit)'},
        {key:'full',label:'30 minutes or more (I want the full picture)'}
      ]
    }
  ];

  var PATTERN_PHRASE={
    samefight:'the fight that keeps coming back',
    startstop:'the start and stop cycle',
    misread:'the way you and others keep misreading each other',
    cannotname:'the thing you can feel but cannot name',
    wired:'how you are wired'
  };
  var AREA_PHRASE={
    relationships:'your relationships',
    family:'your family',
    career:'your career',
    ministry:'your ministry',
    justme:'your own growth'
  };
  var TIME_PHRASE={
    under15:'under 15 minutes',
    mid:'about 20 minutes',
    full:'30 minutes or more'
  };
  var TIER_BY_RANK=['','light','medium','deep'];
  var RANK_BY_TIER={light:1,medium:2,deep:3};

  // Rule-based recommendation.
  //   Primary driver: the time answer (under15 -> Light, mid -> Medium, full -> Deep).
  //   Floors: "cannot name it" needs at least Medium; Ministry or Family areas
  //   point to Deep because the Dynamics pillars unlock there. When a floor
  //   conflicts with the time answer, the higher tier wins (more depth is
  //   safer for a paying customer than shallower), and the copy owns the time
  //   gap honestly.
  //   One explicit exception: "same fight" in Relationships or Family with an
  //   under-15 time answer presents Light (the answer they asked for) and
  //   flags Medium as the better fit for the pattern.
  function recommend(a){
    var base=a.time==='under15'?1:a.time==='mid'?2:3;
    var target=base;
    var sameFightClose=a.pattern==='samefight'&&(a.area==='relationships'||a.area==='family');
    var deepArea=a.area==='ministry'||a.area==='family';
    if(sameFightClose)target=Math.max(target,2);
    if(a.pattern==='cannotname')target=Math.max(target,2);
    if(deepArea)target=Math.max(target,3);
    var flags=[];
    if(sameFightClose&&base===1){
      target=1;
      flags.push('mediumUpgrade');
      if(deepArea)flags.push('deepDynamics');
    }
    if(a.pattern==='cannotname'&&target===2)flags.push('deepMatrix');
    return {tier:TIER_BY_RANK[target],base:TIER_BY_RANK[base],flags:flags};
  }

  function tierReason(tierKey,a,tiers){
    if(tierKey==='light'){
      return 'Solo Light reads your Behavior Profile in '+tiers.light.time+' and names your SR Behavior Archetype. It is a real snapshot, not a teaser.';
    }
    if(tierKey==='medium'){
      return 'Solo Medium covers the four Blueprint pillars needed to name the pattern, plus a 30 day plan to move on it.';
    }
    var dyn=a.area==='ministry'?'Ministry Dynamics':a.area==='family'?'Family Dynamics':a.area==='career'?'Career Dynamics':a.area==='relationships'?'Partnership Dynamics':'the four Dynamics pillars';
    return 'Solo Deep opens all 8 pillars, including '+dyn+', plus the Cross-Pillar Matrix that reads them against each other.';
  }

  function whyCopy(rec,a,tiers){
    var t=tiers[rec.tier];
    var lead;
    if(a.pattern==='wired'){
      lead='You want to understand how you are wired, this is for '+AREA_PHRASE[a.area]+', and you told us you have '+TIME_PHRASE[a.time]+' today.';
    }else{
      lead='You want to work on '+PATTERN_PHRASE[a.pattern]+' in the context of '+AREA_PHRASE[a.area]+', and you told us you have '+TIME_PHRASE[a.time]+' today.';
    }
    var parts=['Here is why: '+lead+' '+tierReason(rec.tier,a,tiers)];
    if(RANK_BY_TIER[rec.tier]>RANK_BY_TIER[rec.base]){
      parts.push('Straight talk: '+t.name+' runs '+t.time+'. That is more than you planned today. We point you there anyway because it is the tier that actually covers what you named. The choice stays yours.');
    }
    if(rec.flags.indexOf('mediumUpgrade')>-1){
      var extra=rec.flags.indexOf('deepDynamics')>-1?' And Family Dynamics unlocks in Solo Deep if you want the full read.':'';
      parts.push('One more thing. If you can find 20 minutes, Solo Medium would serve this pattern better. It adds your Connection Currency and a 30 day plan.'+extra);
    }
    if(rec.flags.indexOf('deepMatrix')>-1){
      parts.push('If you want the fullest answer, Solo Deep adds the Cross-Pillar Matrix. It is built for naming what you can feel but cannot see.');
    }
    return parts;
  }

  var overlay,body,answers={},step=0,tiersData=null,busy=false;

  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function renderStep(){
    var q=QUESTIONS[step];
    var html='<div class="disc-progress">Question '+(step+1)+' of 3</div>';
    html+='<h2 class="disc-title">'+esc(q.title)+'</h2>';
    q.options.forEach(function(o){
      html+='<button type="button" class="disc-opt" data-q="'+q.key+'" data-opt="'+o.key+'">'+esc(o.label)+'</button>';
    });
    html+='<div class="disc-foot">';
    html+=step>0?'<button type="button" class="disc-back" data-act="back">&larr; Back</button>':'<span></span>';
    html+='<button type="button" class="disc-back" data-act="close">Never mind, I will browse</button>';
    html+='</div>';
    body.innerHTML=html;
  }

  function renderResult(){
    var rec=recommend(answers);
    try{localStorage.setItem('sr_discovery',JSON.stringify({area:answers.area,pattern:answers.pattern,time:answers.time,recommended:rec.tier}));}catch(e){}
    var tiers=tiersData.tiers;
    var t=tiers[rec.tier];
    var others=tiersData.order.filter(function(k){return k!==rec.tier;});
    var html='<div class="disc-progress">Based on what you told us</div>';
    html+='<h2 class="disc-title">We recommend '+esc(t.name)+' ('+esc(t.priceDisplay)+').</h2>';
    whyCopy(rec,answers,tiers).forEach(function(p){
      html+='<p class="disc-why">'+esc(p)+'</p>';
    });
    html+='<p class="disc-why disc-facts">'+esc(t.name)+' is '+t.questions+' questions, '+esc(t.time)+'. '+esc(t.delivery)+'.</p>';
    html+='<button type="button" class="tier-btn gold disc-start" data-tier="'+rec.tier+'">Start '+esc(t.name)+' <span class="arr">&rarr;</span></button>';
    html+='<div class="disc-alt-lbl">Or pick a different tier:</div>';
    html+='<div class="disc-alts">';
    others.forEach(function(k){
      html+='<button type="button" class="tier-btn ghost disc-start" data-tier="'+k+'">'+esc(tiers[k].name)+' for '+esc(tiers[k].priceDisplay)+'</button>';
    });
    html+='</div>';
    html+='<div class="disc-foot"><button type="button" class="disc-back" data-act="revise">&larr; Change my answers</button><span></span></div>';
    body.innerHTML=html;
  }

  function open(){
    answers={};step=0;
    overlay.hidden=false;
    document.body.style.overflow='hidden';
    var p=window.SR_TIERS_PROMISE||fetch('/lib/blueprint-tiers.json').then(function(r){return r.json();});
    if(tiersData){renderStep();return;}
    body.innerHTML='<p class="disc-why">One moment&hellip;</p>';
    p.then(function(d){tiersData=d;renderStep();})
     .catch(function(){body.innerHTML='<p class="disc-why">We could not load the tier details. Close this and browse the cards below, everything you need is on them.</p>';});
  }

  function close(){
    overlay.hidden=true;
    document.body.style.overflow='';
  }

  function onBodyClick(ev){
    var el=ev.target.closest('button');
    if(!el||busy)return;
    if(el.getAttribute('data-act')==='close'){close();return;}
    if(el.getAttribute('data-act')==='back'){step=Math.max(0,step-1);renderStep();return;}
    if(el.getAttribute('data-act')==='revise'){renderStep();return;}
    var tier=el.getAttribute('data-tier');
    if(tier){
      busy=true;
      body.querySelectorAll('button').forEach(function(b){b.disabled=true;});
      el.textContent='Heading to checkout...';
      window.srStartCheckout(tier).catch(function(){
        busy=false;
        body.querySelectorAll('button').forEach(function(b){b.disabled=false;});
        el.innerHTML='Try Again <span class="arr">&rarr;</span>';
        var note=body.querySelector('.disc-err');
        if(!note){
          note=document.createElement('p');
          note.className='disc-why disc-err';
          note.style.color='#FCA5A5';
          body.appendChild(note);
        }
        note.textContent='We could not open checkout. Please try again, and if it keeps happening reach out to dennis@dennisnickens.com.';
      });
      return;
    }
    var qk=el.getAttribute('data-q'),ok=el.getAttribute('data-opt');
    if(qk&&ok){
      answers[qk]=ok;
      if(step<QUESTIONS.length-1){step++;renderStep();}
      else{renderResult();}
    }
  }

  document.addEventListener('DOMContentLoaded',function(){
    overlay=document.getElementById('discOverlay');
    body=document.getElementById('discBody');
    if(!overlay||!body)return;
    var trigger=document.getElementById('helpChooseBtn');
    if(trigger)trigger.addEventListener('click',open);
    document.getElementById('discClose').addEventListener('click',close);
    overlay.addEventListener('click',function(ev){if(ev.target===overlay&&!busy)close();});
    document.addEventListener('keydown',function(ev){if(ev.key==='Escape'&&!overlay.hidden&&!busy)close();});
    body.addEventListener('click',onBodyClick);
  });
})();
