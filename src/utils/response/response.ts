export const successResponse = (data:any, message?:string)=>{
    console.log('message', message, data)

    return{ status: 'Success', message: message, statusCode: 200, data: data}
}

export const errorResponse = ( message?:string, statusCode?:any, data?:any,)=>{
    console.log('message', message, data, statusCode)

    return{ status: 'Error', message: message, statusCode: statusCode, data: data}
}