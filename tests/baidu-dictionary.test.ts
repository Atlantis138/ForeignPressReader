import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaiduDictionaryProvider } from '../src/main/baidu-dictionary-provider'

const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})

describe('Baidu dictionary provider',()=>{
  it('authenticates, normalizes nested dictionary JSON, caches and selects two examples',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'baidu-dictionary-'));roots.push(root)
    const dictionary={lang:'1',word_result:{simple_means:{word_name:'take',word_means:['拿','取得'],exchange:{word_past:['took']},tags:{core:['CET4']},symbols:[{ph_en:'teɪk',parts:[{part:'v.',means:['拿','取得','拿']},{part:'noun',means:['an English-only meaning']}]}]},edict:{word:'take',item:[{pos:'verb',tr_group:[{tr:['get into one’s hands'],example:['Can you take this bag from the table, please?'],similar_word:['carry']},{tr:['travel by transport'],example:['She takes the train to work every morning.'],similar_word:['ride']},{tr:['select'],example:['Take any one of these cards from the pile.'],similar_word:[]}]}]}}}
    const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'token',expires_in:2592000}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({result:{trans_result:[{src:'take',dst:'拿',dict:JSON.stringify(dictionary)}],from:'en',to:'zh'}}),{status:200}))
    const secrets={getApiKey:async(id:string)=>id.endsWith('api-key')?'api-key-test-value':'secret-key-test-value'}
    const provider=new BaiduDictionaryProvider(root,secrets as never,{fetch})
    const first=await provider.lookup('take','lex_en_111111111111111111111111')
    const second=await provider.lookup('take','lex_en_111111111111111111111111')
    expect(first).toMatchObject({lemma:'take',providerId:'baidu',phonetic:'teɪk',briefMeanings:['拿','取得'],similarWords:['carry','ride']})
    expect(first?.tags).toEqual([])
    expect(first?.entries).toHaveLength(1)
    expect(first?.entries[0].tags).toEqual([])
    expect(first?.entries[0].senses).toEqual([{partOfSpeech:'动词 · v.',translations:['拿','取得'],definitions:[]}])
    expect(first?.entries.flatMap(entry=>entry.senses).flatMap(sense=>sense.definitions)).toEqual([])
    expect(first?.examples.every(example=>example.definition===null)).toBe(true)
    expect(first?.examples).toHaveLength(2)
    expect(second).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(2)
    provider.close()
  })
})
