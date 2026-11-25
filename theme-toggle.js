(function(){
  function current(){return document.documentElement.getAttribute('data-theme')==='light'?'light':'dark'}
  function sync(btn){btn.setAttribute('aria-pressed',current()==='light'?'true':'false')}
  function init(){
    var btn=document.getElementById('modeToggle');
    if(!btn)return;
    sync(btn);
    btn.addEventListener('click',function(){
      var next=current()==='light'?'dark':'light';
      document.documentElement.setAttribute('data-theme',next);
      try{localStorage.setItem('denvique-theme',next)}catch(e){}
      sync(btn);
    });
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init)}else{init()}
})();
